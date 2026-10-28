/**
 * Gateway side of the audit-read worker (audit-read-worker.ts). One
 * long-lived worker, created on first use and unref'd so it never keeps the
 * process alive; a request that fails or times out replaces it. Nothing
 * starts at import.
 */
import { workerEntry } from "../runner-host/exe";
import type { DayRollup } from "./analytics-rollup";
import {
  auditDir,
  listAuditDates,
  type AuditEventQuery,
  type AuditReadResult,
} from "./audit";
import type { AuditReadRequest } from "./audit-read-worker";

export { listAuditDates };

/** A full day's file takes a few seconds on a loaded host. */
const READ_TIMEOUT_MS = 120_000;

type Pending = {
  resolve: (value: unknown) => void;
  reject: (error: Error) => void;
  timer: ReturnType<typeof setTimeout>;
};

type WorkerHandle = Worker & { unref?(): void };

const state = {
  worker: null as WorkerHandle | null,
  nextId: 1,
  pending: new Map<number, Pending>(),
};

function failAll(error: Error): void {
  state.worker?.terminate();
  state.worker = null;
  for (const [id, pending] of state.pending) {
    clearTimeout(pending.timer);
    state.pending.delete(id);
    pending.reject(error);
  }
}

function ensureWorker(): WorkerHandle {
  if (state.worker) return state.worker;
  const worker = new Worker(
    workerEntry(
      "audit-read-worker.js",
      new URL("./audit-read-worker.ts", import.meta.url).href,
    ),
    { type: "module" },
  ) as WorkerHandle;
  worker.onmessage = (
    event: MessageEvent<{
      id: number;
      ok: boolean;
      value?: unknown;
      error?: string;
    }>,
  ) => {
    if (state.worker !== worker) return;
    const pending = state.pending.get(event.data.id);
    if (!pending) return;
    state.pending.delete(event.data.id);
    clearTimeout(pending.timer);
    if (event.data.ok) pending.resolve(event.data.value);
    else pending.reject(new Error(event.data.error || "Audit read failed"));
  };
  worker.onerror = (event) => {
    if (state.worker !== worker) return;
    failAll(new Error(`Audit read worker failed: ${event.message}`));
  };
  worker.unref?.();
  state.worker = worker;
  return worker;
}

type RequestBody = AuditReadRequest extends infer R
  ? R extends AuditReadRequest
    ? Omit<R, "id">
    : never
  : never;

function call<T>(request: RequestBody, label: string): Promise<T> {
  const worker = ensureWorker();
  const id = state.nextId++;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!state.pending.has(id)) return;
      failAll(new Error(`${label} timed out`));
    }, READ_TIMEOUT_MS);
    timer.unref?.();
    state.pending.set(id, {
      resolve: (value) => resolve(value as T),
      reject,
      timer,
    });
    worker.postMessage({ ...request, id });
  });
}

/** One audit day's Analytics rollup, cached on disk by the worker. */
export function rollupInWorker(
  date: string,
  dir: string,
  cacheDir: string,
): Promise<DayRollup> {
  return call(
    { kind: "rollup", date, auditDir: dir, cacheDir },
    `Analytics rollup for ${date}`,
  );
}

/** One day's audit log rolled up for the Dreaming automation. */
export function buildAuditDigest(
  date: string,
): Promise<Record<string, unknown> | null> {
  return call(
    { kind: "digest", date, auditDir: auditDir() },
    `Audit digest for ${date}`,
  );
}

/** A page of one day's audit events for the Settings viewer. */
export function readAuditEvents(
  query: AuditEventQuery,
): Promise<AuditReadResult> {
  return call(
    { kind: "events", query, auditDir: auditDir() },
    `Audit events for ${query.date}`,
  );
}
