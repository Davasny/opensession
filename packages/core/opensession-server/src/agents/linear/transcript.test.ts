import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  TranscriptStore,
  __setTranscriptStoreForTest,
} from "../../server/transcript-store";
import {
  appendLinearTranscript,
  linearGreetingEntry,
  linearUserEntry,
} from "./transcript";

const dir = mkdtempSync(join(tmpdir(), "linear-transcript-"));
const store = new TranscriptStore(join(dir, "transcripts.db"));
const previous = __setTranscriptStoreForTest(store);

afterAll(() => {
  __setTranscriptStoreForTest(previous);
  store.close();
  rmSync(dir, { recursive: true, force: true });
});

test("greeting uses a stable id and a replay updates the same row", async () => {
  const sessionId = "linear-agent~greeting-test";
  const entry = linearGreetingEntry({
    agentSessionId: "greeting-test",
    text: "What would you like to do?",
    timestamp: "2026-10-01T10:00:00.000Z",
  });

  expect(entry).toMatchObject({
    id: "linear-greeting:greeting-test",
    type: "assistant",
    content: "What would you like to do?",
    timestamp: "2026-10-01T10:00:00.000Z",
  });
  expect(await appendLinearTranscript(sessionId, entry)).toMatchObject({
    inserted: 1,
    updated: 0,
  });
  expect(await appendLinearTranscript(sessionId, entry)).toMatchObject({
    inserted: 0,
    updated: 1,
  });
  expect(store.readTail(sessionId).entries).toHaveLength(1);
});

test("a direction reply keeps its event id and raw text on replay", async () => {
  const sessionId = "linear-agent~reply-test";
  const entry = linearUserEntry({
    agentSessionId: "reply-test",
    activityId: "activity-123",
    text: "plan",
    timestamp: "2026-10-01T10:01:00.000Z",
    sourceTimestamp: "2026-10-01T10:01:00.000Z",
    userId: "user-1",
  });

  expect(entry).toMatchObject({
    id: "linear-activity:activity-123",
    type: "user",
    content: "plan",
  });
  await appendLinearTranscript(sessionId, entry);
  await appendLinearTranscript(sessionId, entry);
  expect(store.readTail(sessionId).entries).toEqual([
    expect.objectContaining({
      id: "linear-activity:activity-123",
      type: "user",
      content: "plan",
      timestamp: "2026-10-01T10:01:00.000Z",
    }),
  ]);
});

test("missing activity id and timestamp do not collapse distinct replies", () => {
  const entry = () =>
    linearUserEntry({
      agentSessionId: "reply-test",
      activityId: null,
      text: "implement",
      timestamp: "2026-10-01T10:10:00.000Z",
      sourceTimestamp: null,
      userId: "user-1",
    });
  expect(entry().id).not.toBe(entry().id);
});

test("missing activity ids fall back to a stable source-time digest", () => {
  const first = linearUserEntry({
    agentSessionId: "reply-test",
    activityId: null,
    text: "implement",
    timestamp: "2026-10-01T10:02:00.000Z",
    sourceTimestamp: "2026-10-01T10:02:00.000Z",
    userId: "user-1",
  });
  const second = linearUserEntry({
    agentSessionId: "reply-test",
    activityId: null,
    text: "implement",
    timestamp: "2026-10-01T10:09:00.000Z",
    sourceTimestamp: "2026-10-01T10:02:00.000Z",
    userId: "user-1",
  });
  expect(first.id).toBe(second.id);
  expect(first.id.startsWith("linear-activity:reply-test:")).toBe(true);
});
