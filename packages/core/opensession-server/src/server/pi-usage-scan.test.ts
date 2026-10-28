import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { scanPiUsage } from "./pi-usage-scan";

const root = mkdtempSync(join(tmpdir(), "pi-usage-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

const session = join(root, "os-019c-session");
const utility = join(root, "utility-run");
mkdirSync(session, { recursive: true });
mkdirSync(utility, { recursive: true });

const message = (
  id: string,
  timestamp: string,
  model: string,
  usage: Record<string, unknown>,
) =>
  JSON.stringify({
    id,
    type: "message",
    timestamp,
    message: {
      role: "assistant",
      timestamp,
      provider: "anthropic",
      model,
      usage,
    },
  });

writeFileSync(
  join(session, "session.jsonl"),
  [
    message("request-a", "2026-08-20T10:00:00Z", "claude-opus-5", {
      input: 10,
      output: 2,
      cacheRead: 20,
      cacheWrite: 3,
      cost: { total: 1.25 },
    }),
    message("request-b", "2026-08-20T11:00:00Z", "anthropic/claude-opus-5", {
      input: 30,
      output: 4,
      cacheRead: 40,
      cacheWrite: 5,
      cost: { total: 2.5 },
    }),
    message("before-cutover", "2026-08-19T12:00:00Z", "claude-opus-5", {
      input: 100,
      output: 100,
      cacheRead: 100,
      cacheWrite: 100,
      cost: { total: 100 },
    }),
    message("after-cutover", "2026-08-19T14:00:00Z", "claude-opus-5", {
      input: 1,
      output: 1,
      cacheRead: 1,
      cacheWrite: 1,
      cost: { total: 1 },
    }),
  ].join("\n"),
);
writeFileSync(
  join(utility, "session.jsonl"),
  message("request-c", "2026-08-20T12:00:00Z", "claude-haiku-4-5", {
    input: 7,
    output: 1,
    cacheRead: 8,
    cacheWrite: 2,
    cost: { total: 0.5 },
  }),
);

test("scans every Pi assistant request and attributes native sessions", async () => {
  const result = await scanPiUsage("2026-08-19", root);
  const day = result.days.get("2026-08-20")!;

  expect(result.complete).toBe(true);
  expect(result.days.get("2026-08-19")).toMatchObject({
    requests: 1,
    totalTokens: 4,
    costUsd: 1,
  });
  expect(day).toMatchObject({
    requests: 3,
    input: 47,
    output: 7,
    cacheRead: 68,
    cacheWrite: 10,
    costUsd: 4.25,
    totalTokens: 132,
  });
  expect(day.byModel).toEqual([
    expect.objectContaining({ model: "claude-opus-5", requests: 2, output: 6 }),
    expect.objectContaining({
      model: "claude-haiku-4-5",
      requests: 1,
      output: 1,
    }),
  ]);
  expect(day.bySession["os-019c-session"]).toEqual({ requests: 2, output: 6 });
  expect(Object.keys(day.bySession)).toHaveLength(1);
});
