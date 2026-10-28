import { afterEach, expect, test } from "bun:test";
import {
  type ModelUsageRecord,
  recordModelUsage,
  setModelUsageForwarder,
  shortModel,
  validModelUsageRecords,
} from "./model-usage";

afterEach(() => setModelUsageForwarder(undefined));

const record: ModelUsageRecord = {
  attemptId: "attempt-1",
  seq: 1,
  at: Date.parse("2026-10-29T10:00:00Z"),
  model: "claude-opus-5",
  input: 1,
  output: 2,
  cacheRead: 3,
  cacheWrite: 4,
  costUsd: 0.5,
};

test("a run host forwards each request, owned only by a native session", () => {
  const sent: Array<[string | undefined, ModelUsageRecord[]]> = [];
  setModelUsageForwarder((sessionId, records) =>
    sent.push([sessionId, records]),
  );
  recordModelUsage("os-0001", record);
  recordModelUsage("bks-ghpr-repo-1", record);
  recordModelUsage("oneshot-1234", record);
  recordModelUsage("slack-C0123", record);
  recordModelUsage(undefined, record);
  expect(sent.map(([sessionId]) => sessionId)).toEqual([
    "os-0001",
    "bks-ghpr-repo-1",
    undefined,
    undefined,
    undefined,
  ]);
});

test("relayed frames keep only well-formed records", () => {
  expect(validModelUsageRecords("nope")).toEqual([]);
  expect(
    validModelUsageRecords([
      record,
      { ...record, seq: 0 },
      { ...record, at: 1.5 },
      { ...record, model: "" },
      { ...record, output: -1 },
      { ...record, costUsd: Number.NaN },
      null,
    ]),
  ).toEqual([record]);
});

test("groups models by their bare name", () => {
  expect(shortModel("pi/anthropic/claude-opus-5")).toBe("claude-opus-5");
  expect(shortModel("anthropic/claude-opus-5")).toBe("claude-opus-5");
  expect(shortModel(undefined)).toBe("unknown");
});
