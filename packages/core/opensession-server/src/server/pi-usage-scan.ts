/**
 * Offline Pi usage scan. OPERATOR ONLY: never import this from the server.
 *
 * Before model usage was counted at the source (model-usage.ts), Analytics
 * rebuilt each day by walking every Pi session directory and reading its
 * JSONL. That cost grows with every session ever run and blocked the gateway,
 * so the server now reads the session kernel's usage catalog instead. Days
 * before the catalog started keep the per-day file the scanner left behind;
 * scripts/pi-usage-backfill.ts uses this module to write one that is missing.
 */
import { createReadStream, readdirSync, statSync } from "node:fs";
import { basename, dirname } from "node:path";
import { createInterface } from "node:readline";
import { shortModel } from "./model-usage";
import { isNativeSessionId, stateDir } from "./paths";
import {
  CUTOVER_DAY,
  PI_USAGE_CUTOVER_MS,
  emptyMutable,
  finishDay,
  type MutableUsage,
  type PiUsageDay,
} from "./pi-usage";

const PI_DIR = () => stateDir("pi");

function messageTimeMs(
  entry: Record<string, unknown>,
  message: Record<string, unknown>,
): number {
  const raw = message.timestamp ?? entry.timestamp;
  if (typeof raw === "number") return raw < 10_000_000_000 ? raw * 1000 : raw;
  if (typeof raw === "string") return Date.parse(raw);
  return Number.NaN;
}

function sessionIdForFile(path: string): string | null {
  const candidate = basename(dirname(path));
  return isNativeSessionId(candidate) ? candidate : null;
}

function jsonlFiles(root: string): string[] {
  const files: string[] = [];
  let dirs;
  try {
    dirs = readdirSync(root, { withFileTypes: true });
  } catch {
    return files;
  }
  for (const dir of dirs) {
    if (!dir.isDirectory()) continue;
    const child = `${root}/${dir.name}`;
    try {
      for (const file of readdirSync(child))
        if (file.endsWith(".jsonl")) files.push(`${child}/${file}`);
    } catch {}
  }
  return files;
}

export async function scanPiUsage(
  fromDate: string,
  root = `${PI_DIR()}/sessions`,
): Promise<{
  days: Map<string, PiUsageDay>;
  earliest: string | null;
  complete: boolean;
}> {
  const fromMs = Date.parse(`${fromDate}T00:00:00Z`);
  const buckets = new Map<string, MutableUsage>();
  const seen = new Set<string>();
  let earliest = "";
  let complete = true;
  let scanned = 0;
  for (const path of jsonlFiles(root)) {
    try {
      if (statSync(path).mtimeMs < fromMs) continue;
      const lines = createInterface({
        input: createReadStream(path, { encoding: "utf8" }),
        crlfDelay: Infinity,
      });
      for await (const line of lines) {
        if (!line || !line.includes('"type":"message"')) continue;
        let entry: Record<string, unknown>;
        try {
          entry = JSON.parse(line);
        } catch {
          continue;
        }
        const message = entry.message as Record<string, unknown> | undefined;
        if (!message || message.role !== "assistant") continue;
        const usage = message.usage as Record<string, unknown> | undefined;
        if (!usage) continue;
        const time = messageTimeMs(entry, message);
        if (!Number.isFinite(time)) continue;
        const date = new Date(time).toISOString().slice(0, 10);
        if (!earliest || date < earliest) earliest = date;
        if (
          time < fromMs ||
          (date === CUTOVER_DAY && time < PI_USAGE_CUTOVER_MS)
        )
          continue;
        const id = String(entry.id || "");
        if (id && seen.has(id)) continue;
        if (id) seen.add(id);
        const bucket = buckets.get(date) || emptyMutable();
        buckets.set(date, bucket);
        const model = shortModel(message.model);
        const modelUsage = bucket.byModel.get(model) || {
          model,
          requests: 0,
          input: 0,
          output: 0,
          cacheRead: 0,
          cacheWrite: 0,
          costUsd: 0,
        };
        modelUsage.requests++;
        modelUsage.input += Number(usage.input) || 0;
        modelUsage.output += Number(usage.output) || 0;
        modelUsage.cacheRead += Number(usage.cacheRead) || 0;
        modelUsage.cacheWrite += Number(usage.cacheWrite) || 0;
        modelUsage.costUsd +=
          Number((usage.cost as Record<string, unknown> | undefined)?.total) ||
          0;
        bucket.byModel.set(model, modelUsage);
        const session = sessionIdForFile(path);
        if (session) {
          const sessionUsage = bucket.bySession.get(session) || {
            requests: 0,
            output: 0,
          };
          sessionUsage.requests++;
          sessionUsage.output += Number(usage.output) || 0;
          bucket.bySession.set(session, sessionUsage);
        }
      }
    } catch (error) {
      complete = false;
      console.error(`[analytics] Pi usage file unreadable: ${path}`, error);
    }
    if (++scanned % 25 === 0)
      await new Promise((resolve) => setTimeout(resolve, 0));
  }
  return {
    days: new Map(
      [...buckets].map(([date, value]) => [date, finishDay(value)]),
    ),
    earliest: earliest || null,
    complete,
  };
}
