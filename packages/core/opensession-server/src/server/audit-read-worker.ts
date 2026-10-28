/**
 * Worker for whole-day audit reads: Analytics/Home day rollups
 * (analytics-rollup.ts), the Dreaming digest and the Settings audit viewer
 * (audit.ts). A day's audit file reaches 100 MB; reading and parsing it on
 * the gateway thread blocked every request behind it. Spawned lazily by
 * audit-read-client.ts.
 */
import { cachedAuditRollup } from "./analytics-rollup";
import {
  buildAuditDigestIn,
  readAuditEventsIn,
  type AuditEventQuery,
} from "./audit";

declare const self: Worker;

export type AuditReadRequest = { id: number } & (
  | { kind: "rollup"; date: string; auditDir: string; cacheDir: string }
  | { kind: "digest"; date: string; auditDir: string }
  | { kind: "events"; query: AuditEventQuery; auditDir: string }
);

function run(request: AuditReadRequest): unknown {
  if (request.kind === "rollup")
    return cachedAuditRollup(request.date, request.auditDir, request.cacheDir);
  if (request.kind === "digest")
    return buildAuditDigestIn(request.auditDir, request.date);
  return readAuditEventsIn(request.auditDir, request.query);
}

self.onmessage = (event: MessageEvent<AuditReadRequest>) => {
  const { id } = event.data;
  try {
    self.postMessage({ id, ok: true, value: run(event.data) });
  } catch (error) {
    self.postMessage({
      id,
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};
