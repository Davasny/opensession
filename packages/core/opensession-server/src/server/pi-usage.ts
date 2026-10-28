/**
 * Pi model usage per UTC day, for Analytics and Home.
 *
 * Usage is counted at the source: Pi records each finished request
 * (model-usage.ts), the owning session's actor counts it per day and model,
 * and the session kernel's central catalog projects every session's counters
 * (session-kernel/usage-store.ts). A day is one indexed catalog query; the
 * gateway never walks engine session files.
 *
 * Days before the catalog started are served from the per-day files the
 * retired file scanner wrote (pi-usage-scan.ts; scripts/pi-usage-backfill.ts
 * writes a missing one offline). Days before the Pi cutover keep the final
 * OpenCode measurement or their audit rows.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { PI_USAGE_CUTOVER_MS } from "./analytics-rollup";
import { shortModel } from "./model-usage";
import { isNativeSessionId, stateDir } from "./paths";
import { sessionUsage, type UsageDayRow } from "./session-kernel";

export interface PiModelUsage {
  model: string;
  requests: number;
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  costUsd: number;
}

export interface PiUsageDay {
  byModel: PiModelUsage[];
  bySession: Record<string, { requests: number; output: number }>;
  sessionAttribution: "measured" | "unmeasured";
  coverage: { pi: "measured" | "unmeasured" };
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  totalTokens: number;
  costUsd: number;
  requests: number;
  unpricedRequests: number;
  unmeasured: boolean;
}

export interface MutableUsage {
  byModel: Map<string, PiModelUsage>;
  bySession: Map<string, { requests: number; output: number }>;
}
const CACHE_DIR = () => stateDir("analytics-cache");
const CACHE_VERSION = 1;
export { PI_USAGE_CUTOVER_MS };
export const CUTOVER_DAY = "2026-08-19";
/** The first whole UTC day the usage catalog counted. Earlier days come from
 * the retired scanner's per-day files. */
export const USAGE_CATALOG_START_DAY = "2026-10-29";
const TODAY_TTL_MS = 60_000;
/** Finished days do not change; keep about a year of them. */
const MAX_REMEMBERED_DAYS = 400;
const remembered = new Map<string, { at: number; day: PiUsageDay }>();

export function emptyMutable(): MutableUsage {
  return { byModel: new Map(), bySession: new Map() };
}

export function emptyDay(unmeasured = false): PiUsageDay {
  return {
    byModel: [],
    bySession: {},
    sessionAttribution: unmeasured ? "unmeasured" : "measured",
    coverage: { pi: unmeasured ? "unmeasured" : "measured" },
    input: 0,
    output: 0,
    cacheRead: 0,
    cacheWrite: 0,
    totalTokens: 0,
    costUsd: 0,
    requests: 0,
    unpricedRequests: 0,
    unmeasured,
  };
}

export function finishDay(value: MutableUsage): PiUsageDay {
  const day = emptyDay();
  day.byModel = [...value.byModel.values()].sort(
    (a, b) =>
      b.costUsd - a.costUsd || b.cacheRead + b.input - (a.cacheRead + a.input),
  );
  day.bySession = Object.fromEntries(value.bySession);
  for (const usage of day.byModel) {
    day.requests += usage.requests;
    day.input += usage.input;
    day.output += usage.output;
    day.cacheRead += usage.cacheRead;
    day.cacheWrite += usage.cacheWrite;
    day.costUsd += usage.costUsd;
  }
  day.totalTokens = day.input + day.output + day.cacheRead + day.cacheWrite;
  return day;
}

async function readLegacyAuditDay(date: string): Promise<PiUsageDay | null> {
  const path = `${stateDir("audit")}/audit-${date}.jsonl`;
  let text: string;
  try {
    text = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const bucket = emptyMutable();
  for (const line of text.split("\n")) {
    if (!line.includes('"kind":"result"')) continue;
    let event: Record<string, unknown>;
    try {
      event = JSON.parse(line);
    } catch {
      continue;
    }
    const time = Date.parse(String(event.time || ""));
    if (
      date === CUTOVER_DAY &&
      (!Number.isFinite(time) || time >= PI_USAGE_CUTOVER_MS)
    )
      continue;
    const model = shortModel(event.model);
    const usage = bucket.byModel.get(model) || {
      model,
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    };
    usage.requests += Number(event.steps) || 1;
    usage.input += Number(event.input_tokens) || 0;
    usage.output += Number(event.output_tokens) || 0;
    usage.cacheRead += Number(event.cache_read_input_tokens) || 0;
    usage.cacheWrite += Number(event.cache_creation_input_tokens) || 0;
    usage.costUsd += Number(event.total_cost_usd) || 0;
    bucket.byModel.set(model, usage);
    const session = String(event.session_id || event.bks_session_id || "");
    if (isNativeSessionId(session)) {
      const sessionUsage = bucket.bySession.get(session) || {
        requests: 0,
        output: 0,
      };
      sessionUsage.requests += Number(event.steps) || 1;
      sessionUsage.output += Number(event.output_tokens) || 0;
      bucket.bySession.set(session, sessionUsage);
    }
  }
  return bucket.byModel.size ? finishDay(bucket) : null;
}

/** Preserve the final OpenCode measurement on the mixed cutover day and all
 * earlier days. The retired scanner wrote this versioned shape once per day;
 * the cutover day's still-volatile measurement falls back to its audit rows. */
async function readLegacyEngineDay(date: string): Promise<PiUsageDay | null> {
  try {
    const parsed = JSON.parse(
      await readFile(`${CACHE_DIR()}/engine-day-${date}.json`, "utf8"),
    );
    const day = parsed?.day;
    if (!day || !Array.isArray(day.byModel))
      throw new Error("invalid legacy usage cache");
    return {
      ...emptyDay(!!day.unmeasured),
      ...day,
      byModel: day.byModel.map((usage: Record<string, unknown>) => ({
        model: String(usage.model || "unknown"),
        requests: Number(usage.requests) || 0,
        input: Number(usage.input) || 0,
        output: Number(usage.output) || 0,
        cacheRead: Number(usage.cacheRead) || 0,
        cacheWrite: Number(usage.cacheWrite) || 0,
        costUsd: Number(usage.costUsd) || 0,
      })),
      bySession: day.bySession || {},
      coverage: { pi: day.unmeasured ? "unmeasured" : "measured" },
    };
  } catch {
    return await readLegacyAuditDay(date);
  }
}

function cachePath(date: string): string {
  return `${CACHE_DIR()}/pi-day-v${CACHE_VERSION}-${date}.json`;
}

async function readCache(date: string): Promise<PiUsageDay | null> {
  try {
    const parsed = JSON.parse(await readFile(cachePath(date), "utf8"));
    return parsed?.v === CACHE_VERSION && parsed?.day ? parsed.day : null;
  } catch {
    return null;
  }
}

/** Offline backfill only (scripts/pi-usage-backfill.ts). */
export async function writePiUsageCache(
  date: string,
  day: PiUsageDay,
): Promise<string> {
  await mkdir(CACHE_DIR(), { recursive: true });
  const path = cachePath(date);
  await writeFile(path, JSON.stringify({ v: CACHE_VERSION, day }));
  return path;
}

/** Fold one date's catalog rows into the day shape Analytics reads. */
export function usageDayFromCatalog(rows: UsageDayRow[]): PiUsageDay {
  const bucket = emptyMutable();
  for (const row of rows) {
    const model = shortModel(row.model);
    const usage = bucket.byModel.get(model) || {
      model,
      requests: 0,
      input: 0,
      output: 0,
      cacheRead: 0,
      cacheWrite: 0,
      costUsd: 0,
    };
    usage.requests += row.requests;
    usage.input += row.input;
    usage.output += row.output;
    usage.cacheRead += row.cacheRead;
    usage.cacheWrite += row.cacheWrite;
    usage.costUsd += row.costUsd;
    bucket.byModel.set(model, usage);
    if (isNativeSessionId(row.sessionId)) {
      const session = bucket.bySession.get(row.sessionId) || {
        requests: 0,
        output: 0,
      };
      session.requests += row.requests;
      session.output += row.output;
      bucket.bySession.set(row.sessionId, session);
    }
  }
  return finishDay(bucket);
}

async function measureDay(date: string): Promise<PiUsageDay | null> {
  if (date >= USAGE_CATALOG_START_DAY) {
    try {
      return usageDayFromCatalog(await sessionUsage({ op: "day", date }));
    } catch (error) {
      console.warn(
        `[analytics] usage catalog read failed for ${date}:`,
        error instanceof Error ? error.message : error,
      );
      return null;
    }
  }
  const cached = await readCache(date);
  if (cached) return cached;
  if (date <= CUTOVER_DAY) {
    const legacy = await readLegacyEngineDay(date);
    if (legacy) return legacy;
  }
  return null;
}

export async function piUsageForDates(
  dates: string[],
): Promise<Map<string, PiUsageDay>> {
  const today = new Date().toISOString().slice(0, 10);
  const out = new Map<string, PiUsageDay>();
  for (const date of new Set(dates)) {
    const known = remembered.get(date);
    if (known && (date < today || Date.now() - known.at < TODAY_TTL_MS)) {
      out.set(date, known.day);
      continue;
    }
    if (date > today) {
      out.set(date, emptyDay());
      continue;
    }
    const day = await measureDay(date);
    if (!day) {
      // Unavailable is not zero: say so, and ask again next time.
      out.set(date, emptyDay(true));
      continue;
    }
    remembered.delete(date);
    remembered.set(date, { at: Date.now(), day });
    while (remembered.size > MAX_REMEMBERED_DAYS) {
      const oldest = remembered.keys().next().value;
      if (oldest === undefined) break;
      remembered.delete(oldest);
    }
    out.set(date, day);
  }
  return out;
}
