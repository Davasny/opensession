/**
 * SQL for actor-owned model usage and its central catalog projection; see
 * usage-protocol.ts for the contract.
 *
 * `session_kernel_usage_days` and `session_kernel_usage_attempts` live in the
 * owning actor database (or the central database for legacy central
 * placements). `session_kernel_usage_catalog` lives in the central database:
 * one row per (date, session, model), overwritten from the actor's counters
 * after each commit, plus rows for usage no session owns, which the catalog
 * counts itself. All three tables exist in every kernel database because they
 * share one schema.
 */
import type { Database } from "bun:sqlite";
import {
  assertUsageActorRequest,
  type ModelUsageRecord,
  type UsageDayRow,
  usageDate,
} from "./usage-protocol";

/** Attempt high-water marks only dedupe re-delivery of a live run's frames.
 * A month is far longer than any run, and keeps the table small. */
const ATTEMPT_RETENTION_MS = 30 * 24 * 60 * 60_000;

type CounterRow = {
  session_id: string;
  model: string;
  requests: number;
  input: number;
  output: number;
  cache_read: number;
  cache_write: number;
  cost_usd: number;
};

export function migrateUsageSchema35(
  db: Database,
  schemaVersion: number,
): void {
  if (schemaVersion >= 35) return;
  const tx = db.transaction(() => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS session_kernel_usage_days (
        session_id TEXT NOT NULL,
        date TEXT NOT NULL,
        model TEXT NOT NULL,
        requests INTEGER NOT NULL CHECK(requests >= 0),
        input INTEGER NOT NULL CHECK(input >= 0),
        output INTEGER NOT NULL CHECK(output >= 0),
        cache_read INTEGER NOT NULL CHECK(cache_read >= 0),
        cache_write INTEGER NOT NULL CHECK(cache_write >= 0),
        cost_usd REAL NOT NULL CHECK(cost_usd >= 0),
        PRIMARY KEY (session_id, date, model)
      ) STRICT, WITHOUT ROWID;
      CREATE TABLE IF NOT EXISTS session_kernel_usage_attempts (
        attempt_id TEXT PRIMARY KEY,
        seq INTEGER NOT NULL CHECK(seq >= 1),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0)
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_skua_updated
        ON session_kernel_usage_attempts(updated_at);
      CREATE TABLE IF NOT EXISTS session_kernel_usage_catalog (
        date TEXT NOT NULL,
        session_id TEXT NOT NULL,
        model TEXT NOT NULL,
        requests INTEGER NOT NULL CHECK(requests >= 0),
        input INTEGER NOT NULL CHECK(input >= 0),
        output INTEGER NOT NULL CHECK(output >= 0),
        cache_read INTEGER NOT NULL CHECK(cache_read >= 0),
        cache_write INTEGER NOT NULL CHECK(cache_write >= 0),
        cost_usd REAL NOT NULL CHECK(cost_usd >= 0),
        updated_at INTEGER NOT NULL CHECK(updated_at >= 0),
        PRIMARY KEY (date, session_id, model)
      ) STRICT, WITHOUT ROWID;
      PRAGMA user_version = 35;
    `);
  });
  tx.immediate();
}

/** Records not yet counted, in attempt order. A record at or below its
 * attempt's high-water mark was counted by an earlier delivery. */
function freshRecords(
  db: Database,
  records: ModelUsageRecord[],
): ModelUsageRecord[] {
  const read = db.query(
    "SELECT seq FROM session_kernel_usage_attempts WHERE attempt_id = ?",
  );
  const highWater = new Map<string, number>();
  const fresh: ModelUsageRecord[] = [];
  const ordered = [...records].sort(
    (a, b) => a.attemptId.localeCompare(b.attemptId) || a.seq - b.seq,
  );
  for (const record of ordered) {
    let mark = highWater.get(record.attemptId);
    if (mark === undefined) {
      const row = read.get(record.attemptId) as { seq: number } | null;
      mark = row ? Number(row.seq) : 0;
    }
    if (record.seq <= mark) continue;
    highWater.set(record.attemptId, record.seq);
    fresh.push(record);
  }
  const now = Date.now();
  const write = db.query(
    `INSERT INTO session_kernel_usage_attempts (attempt_id, seq, updated_at)
     VALUES (?, ?, ?)
     ON CONFLICT(attempt_id) DO UPDATE SET
       seq = max(seq, excluded.seq), updated_at = excluded.updated_at`,
  );
  for (const [attemptId, seq] of highWater) write.run(attemptId, seq, now);
  db.run("DELETE FROM session_kernel_usage_attempts WHERE updated_at < ?", [
    now - ATTEMPT_RETENTION_MS,
  ]);
  return fresh;
}

function tokens(value: number): number {
  return Math.round(value);
}

function addCounters(
  db: Database,
  table: "session_kernel_usage_days" | "session_kernel_usage_catalog",
  sessionId: string,
  records: ModelUsageRecord[],
): Set<string> {
  const catalog = table === "session_kernel_usage_catalog";
  const add = db.query(
    `INSERT INTO ${table}
       (session_id, date, model, requests, input, output, cache_read,
        cache_write, cost_usd${catalog ? ", updated_at" : ""})
     VALUES (?, ?, ?, 1, ?, ?, ?, ?, ?${catalog ? ", ?" : ""})
     ON CONFLICT(${catalog ? "date, session_id, model" : "session_id, date, model"})
     DO UPDATE SET
       requests = requests + 1,
       input = input + excluded.input,
       output = output + excluded.output,
       cache_read = cache_read + excluded.cache_read,
       cache_write = cache_write + excluded.cache_write,
       cost_usd = cost_usd + excluded.cost_usd${
         catalog ? ", updated_at = excluded.updated_at" : ""
       }`,
  );
  const dates = new Set<string>();
  const now = Date.now();
  for (const record of records) {
    const date = usageDate(record.at);
    dates.add(date);
    const values = [
      sessionId,
      date,
      record.model,
      tokens(record.input),
      tokens(record.output),
      tokens(record.cacheRead),
      tokens(record.cacheWrite),
      record.costUsd,
    ];
    if (catalog) values.push(now);
    add.run(...values);
  }
  return dates;
}

/** Actor side: count a session's fresh records. Returns the UTC dates whose
 * counters changed, which the caller re-projects into the catalog. */
export function recordSessionUsage(
  db: Database,
  sessionId: string,
  records: ModelUsageRecord[],
): { counted: number; dates: string[] } {
  assertUsageActorRequest({ op: "record", sessionId, records });
  const tx = db.transaction(() => {
    const fresh = freshRecords(db, records);
    const dates = addCounters(
      db,
      "session_kernel_usage_days",
      sessionId,
      fresh,
    );
    return { counted: fresh.length, dates: [...dates] };
  });
  return tx.immediate();
}

/** Central only: count usage no session actor owns. */
export function recordUnownedUsage(
  db: Database,
  label: string,
  records: ModelUsageRecord[],
): number {
  assertUsageActorRequest({ op: "record_unowned", label, records });
  const tx = db.transaction(() => {
    const fresh = freshRecords(db, records);
    addCounters(db, "session_kernel_usage_catalog", label, fresh);
    return fresh.length;
  });
  return tx.immediate();
}

/** Actor side: the session's counters for the given dates. */
export function sessionUsageDays(
  db: Database,
  sessionId: string,
  dates: string[],
): Array<UsageDayRow & { date: string }> {
  if (!dates.length) return [];
  const placeholders = dates.map(() => "?").join(", ");
  return (
    db
      .query(
        `SELECT session_id, date, model, requests, input, output, cache_read,
                cache_write, cost_usd
         FROM session_kernel_usage_days
         WHERE session_id = ? AND date IN (${placeholders})`,
      )
      .all(sessionId, ...dates) as Array<CounterRow & { date: string }>
  ).map((row) => ({ ...counterRow(row), date: row.date }));
}

/** Central only: replace the catalog's rows for one session's dates with the
 * actor's current counters. Overwriting makes a repeated settle exact. */
export function settleSessionUsageCatalog(
  db: Database,
  sessionId: string,
  rows: Array<UsageDayRow & { date: string }>,
): void {
  const write = db.query(
    `INSERT INTO session_kernel_usage_catalog
       (date, session_id, model, requests, input, output, cache_read,
        cache_write, cost_usd, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(date, session_id, model) DO UPDATE SET
       requests = excluded.requests,
       input = excluded.input,
       output = excluded.output,
       cache_read = excluded.cache_read,
       cache_write = excluded.cache_write,
       cost_usd = excluded.cost_usd,
       updated_at = excluded.updated_at`,
  );
  const tx = db.transaction(() => {
    const now = Date.now();
    for (const row of rows)
      write.run(
        row.date,
        sessionId,
        row.model,
        row.requests,
        row.input,
        row.output,
        row.cacheRead,
        row.cacheWrite,
        row.costUsd,
        now,
      );
  });
  tx.immediate();
}

/** Central only: every session's counters for one UTC date. */
export function usageCatalogDay(db: Database, date: string): UsageDayRow[] {
  assertUsageActorRequest({ op: "day", date });
  return (
    db
      .query(
        `SELECT session_id, model, requests, input, output, cache_read,
                cache_write, cost_usd
         FROM session_kernel_usage_catalog WHERE date = ?
         ORDER BY session_id, model`,
      )
      .all(date) as CounterRow[]
  ).map(counterRow);
}

function counterRow(row: CounterRow): UsageDayRow {
  return {
    sessionId: row.session_id,
    model: row.model,
    requests: Number(row.requests),
    input: Number(row.input),
    output: Number(row.output),
    cacheRead: Number(row.cache_read),
    cacheWrite: Number(row.cache_write),
    costUsd: Number(row.cost_usd),
  };
}
