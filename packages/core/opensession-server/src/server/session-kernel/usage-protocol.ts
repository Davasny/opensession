/**
 * Model usage ownership.
 *
 * Every model request a session makes is recorded once, by the session's own
 * actor, as per-day per-model counters. The actor also keeps a high-water mark
 * per engine attempt, so a relayed batch that arrives twice (a run host
 * reattaching, a WS replay) adds nothing the second time. Each committed write
 * re-projects that session's touched days into a central catalog table, so a
 * cross-session read (Analytics) is one indexed query on the catalog and never
 * opens an actor or walks engine files.
 *
 * Requests with no Open Session to own them (utility one-shots, detached
 * auxiliary workers) are counted in the central catalog directly, under the
 * empty session id, with the same attempt high-water dedupe.
 */

export type ModelUsageRecord = {
  /** One engine attempt (a run's account/model walk step). Opaque. */
  attemptId: string;
  /** 1-based, increasing within the attempt in request order. */
  seq: number;
  /** When the request finished, epoch ms. Its UTC date buckets the record. */
  at: number;
  model: string;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
};

export type UsageDayRow = {
  /** Empty when no Open Session owns the usage. */
  sessionId: string;
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
};

export type UsageActorRequest =
  /** Count a session's requests in its actor and re-project its days. */
  | { op: "record"; sessionId: string; records: ModelUsageRecord[] }
  /** Count requests no session actor owns, in the central catalog only.
   * `label` names a session whose actor can no longer take writes (deleted
   * or quarantined); it is otherwise empty. */
  | { op: "record_unowned"; label: string; records: ModelUsageRecord[] }
  /** Every session's counters for one UTC date, from the central catalog. */
  | { op: "day"; date: string };

export type UsageActorResult<T extends UsageActorRequest> = T extends {
  op: "day";
}
  ? UsageDayRow[]
  : /** Records counted; duplicates are skipped. */
    number;

export const USAGE_MAX_RECORDS = 500;
const MAX_ID_CHARS = 200;
const MAX_MODEL_CHARS = 200;
const DATE = /^\d{4}-\d{2}-\d{2}$/;

export function isUsageRead(request: UsageActorRequest): boolean {
  return request.op === "day";
}

export function usageDate(at: number): string {
  return new Date(at).toISOString().slice(0, 10);
}

function count(value: unknown): boolean {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

export function assertUsageActorRequest(request: UsageActorRequest): void {
  if (request.op === "day") {
    if (typeof request.date !== "string" || !DATE.test(request.date))
      throw new Error("Invalid usage date");
    return;
  }
  if (request.op === "record") {
    if (typeof request.sessionId !== "string" || !request.sessionId)
      throw new Error("Usage record requires a session id");
  } else if (request.op === "record_unowned") {
    if (typeof request.label !== "string" || request.label.length > 256)
      throw new Error("Invalid usage label");
  } else {
    throw new Error(
      `Unknown usage op ${String((request as { op?: unknown }).op)}`,
    );
  }
  if (
    !Array.isArray(request.records) ||
    request.records.length < 1 ||
    request.records.length > USAGE_MAX_RECORDS
  )
    throw new Error("Invalid usage record batch");
  for (const record of request.records) {
    if (
      typeof record.attemptId !== "string" ||
      !record.attemptId ||
      record.attemptId.length > MAX_ID_CHARS
    )
      throw new Error("Invalid usage attempt id");
    if (!Number.isInteger(record.seq) || record.seq < 1)
      throw new Error("Invalid usage sequence");
    if (!Number.isInteger(record.at) || record.at < 0)
      throw new Error("Invalid usage timestamp");
    if (
      typeof record.model !== "string" ||
      !record.model ||
      record.model.length > MAX_MODEL_CHARS
    )
      throw new Error("Invalid usage model");
    for (const field of [
      record.input,
      record.output,
      record.cacheRead,
      record.cacheWrite,
      record.costUsd,
    ])
      if (!count(field)) throw new Error("Invalid usage count");
  }
}
