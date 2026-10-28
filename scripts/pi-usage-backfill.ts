/**
 * Offline operator job: write the per-day Pi usage file for days before the
 * session kernel's usage catalog started counting.
 *
 * The server never scans Pi session files. Days from
 * USAGE_CATALOG_START_DAY on are read from the usage catalog; earlier days
 * read the file this writes (the retired in-server scanner wrote the same
 * file). Run it for a finished day whose file is missing, at low priority:
 *
 *   nice -n 19 bun scripts/pi-usage-backfill.ts 2026-10-28 [more dates]
 *
 * It refuses today and catalog days. Rerunning a date overwrites its file.
 */

import { scanPiUsage } from "../packages/core/opensession-server/src/server/pi-usage-scan";
import {
  CUTOVER_DAY,
  USAGE_CATALOG_START_DAY,
  writePiUsageCache,
} from "../packages/core/opensession-server/src/server/pi-usage";

const dates = process.argv.slice(2);
const today = new Date().toISOString().slice(0, 10);
if (!dates.length) {
  console.error("usage: bun scripts/pi-usage-backfill.ts <YYYY-MM-DD>...");
  process.exit(2);
}
for (const date of dates) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    console.error(`${date}: not a YYYY-MM-DD date`);
    process.exit(2);
  }
  if (date >= today || date >= USAGE_CATALOG_START_DAY || date <= CUTOVER_DAY) {
    console.error(
      `${date}: only finished days after ${CUTOVER_DAY} and before ${USAGE_CATALOG_START_DAY} are read from these files`,
    );
    process.exit(2);
  }
}

const from = dates.reduce((a, b) => (a < b ? a : b));
const scanned = await scanPiUsage(from);
for (const date of dates) {
  const day = scanned.days.get(date);
  if (!day) {
    console.log(`${date}: no Pi requests found; nothing written`);
    continue;
  }
  if (!scanned.complete) {
    day.unmeasured = true;
    day.coverage.pi = "unmeasured";
    day.sessionAttribution = "unmeasured";
  }
  const path = await writePiUsageCache(date, day);
  console.log(
    `${date}: ${day.requests} requests, $${day.costUsd.toFixed(2)}${scanned.complete ? "" : " (some files were unreadable)"} -> ${path}`,
  );
}
