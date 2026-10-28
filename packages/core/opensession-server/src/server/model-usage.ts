/**
 * Model usage recording.
 *
 * Pi reports each request's tokens and cost as it finishes. That is recorded
 * here once, at the source, instead of being rediscovered later by scanning
 * engine session files. In the server process the records are batched into
 * the owning session's actor (session-kernel/usage-protocol.ts), which counts
 * them per day and model and projects them into the central catalog. Inside a
 * run host a forwarder is registered instead (runner-host/host.ts): records
 * ride the run-host protocol's `usage` frame to the server, the same way
 * transcript lines do. Each record carries its attempt id and sequence, so a
 * frame delivered twice counts once.
 *
 * Nothing here starts a timer or touches the kernel at import time.
 */
import { isNativeSessionId } from "./paths";
import {
  USAGE_MAX_RECORDS,
  type ModelUsageRecord,
} from "./session-kernel/usage-protocol";

export type { ModelUsageRecord };

export type ModelUsageForwarder = (
  sessionId: string | undefined,
  records: ModelUsageRecord[],
) => void;

const FLUSH_DELAY_MS = 1_000;
const MAX_PENDING_RECORDS = 20_000;
const MAX_FLUSH_FAILURES = 5;

type Pending = { records: ModelUsageRecord[]; failures: number };

type RecorderState = {
  /** Keyed by owning session id; "" holds usage no session owns. */
  pending: Map<string, Pending>;
  size: number;
  timer?: ReturnType<typeof setTimeout>;
  flushing: boolean;
};

const g = globalThis as {
  __osUsageForwarder?: ModelUsageForwarder;
  __osUsageRecorder?: RecorderState;
};

function recorder(): RecorderState {
  return (g.__osUsageRecorder ??= {
    pending: new Map(),
    size: 0,
    flushing: false,
  });
}

/** Run hosts register a forwarder before driving the run. */
export function setModelUsageForwarder(
  fn: ModelUsageForwarder | undefined,
): void {
  g.__osUsageForwarder = fn;
}

/** The model name usage is grouped by: provider and route prefixes removed. */
export function shortModel(model: unknown): string {
  const stripped = String(model || "unknown").replace(
    /^(?:pi|claude|codex|opencode)\/[^/]+\//,
    "",
  );
  return stripped.split("/").pop() || "unknown";
}

/** Only Open Session and background sessions have an actor to own usage. */
function owner(sessionId: string | undefined): string | undefined {
  return sessionId && isNativeSessionId(sessionId) ? sessionId : undefined;
}

/** Record one finished model request. Never throws and never blocks. */
export function recordModelUsage(
  sessionId: string | undefined,
  record: ModelUsageRecord,
): void {
  const forward = g.__osUsageForwarder;
  if (forward) {
    try {
      forward(owner(sessionId), [record]);
    } catch (error) {
      console.warn("[usage] forward failed:", error);
    }
    return;
  }
  // Unit tests share these modules with live paths; keep their fake runs out
  // of the kernel.
  if (process.env.NODE_ENV === "test") return;
  enqueue(owner(sessionId) ?? "", [record]);
}

function isRecord(value: unknown): value is ModelUsageRecord {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return (
    typeof record.attemptId === "string" &&
    !!record.attemptId &&
    Number.isInteger(record.seq) &&
    (record.seq as number) >= 1 &&
    Number.isInteger(record.at) &&
    typeof record.model === "string" &&
    !!record.model &&
    [
      record.input,
      record.output,
      record.cacheRead,
      record.cacheWrite,
      record.costUsd,
    ].every(
      (field) =>
        typeof field === "number" && Number.isFinite(field) && field >= 0,
    )
  );
}

/** The well-formed records of a relayed frame. */
export function validModelUsageRecords(records: unknown): ModelUsageRecord[] {
  return Array.isArray(records) ? records.filter(isRecord) : [];
}

/** Server side of the run-host `usage` frame. Hosts are trusted to report
 * their own spend; malformed records are dropped rather than failing the
 * frame. */
export function applyRelayedModelUsage(
  sessionId: unknown,
  records: unknown,
): void {
  const valid = validModelUsageRecords(records);
  if (!valid.length) return;
  enqueue(
    owner(typeof sessionId === "string" ? sessionId : undefined) ?? "",
    valid,
  );
}

function enqueue(key: string, records: ModelUsageRecord[]): void {
  const state = recorder();
  if (state.size + records.length > MAX_PENDING_RECORDS) {
    console.warn(
      `[usage] ${records.length} usage record(s) dropped: ${state.size} already waiting for the session kernel`,
    );
    return;
  }
  const pending = state.pending.get(key);
  if (pending) pending.records.push(...records);
  else state.pending.set(key, { records: [...records], failures: 0 });
  state.size += records.length;
  scheduleFlush();
}

function scheduleFlush(): void {
  const state = recorder();
  if (state.timer || state.flushing) return;
  state.timer = setTimeout(() => {
    state.timer = undefined;
    void flushModelUsage();
  }, FLUSH_DELAY_MS);
  state.timer.unref?.();
}

/** Send every waiting batch. Exported for shutdown and tests. */
export async function flushModelUsage(): Promise<void> {
  const state = recorder();
  if (state.flushing) return;
  state.flushing = true;
  try {
    const { sessionUsage } = await import("./session-kernel");
    const batches = [...state.pending];
    state.pending.clear();
    state.size = 0;
    for (const [key, batch] of batches) {
      for (let at = 0; at < batch.records.length; at += USAGE_MAX_RECORDS) {
        const records = batch.records.slice(at, at + USAGE_MAX_RECORDS);
        try {
          await (key
            ? sessionUsage({ op: "record", sessionId: key, records })
            : sessionUsage({ op: "record_unowned", label: "", records }));
        } catch (error) {
          // A retry is exact: the attempt high-water mark skips any record
          // the failed call did count.
          if (batch.failures + 1 >= MAX_FLUSH_FAILURES) {
            console.warn(
              `[usage] dropped ${records.length} usage record(s) for ${key || "unowned usage"} after ${MAX_FLUSH_FAILURES} failures:`,
              error instanceof Error ? error.message : error,
            );
            continue;
          }
          const retry = state.pending.get(key);
          if (retry) {
            retry.records.unshift(...records);
            retry.failures = Math.max(retry.failures, batch.failures + 1);
          } else
            state.pending.set(key, {
              records: [...records],
              failures: batch.failures + 1,
            });
          state.size += records.length;
        }
      }
    }
  } finally {
    state.flushing = false;
    if (state.size) scheduleFlush();
  }
}
