import { describe, expect, test } from "bun:test";
import { needsSeenMark, seenByLabel, seenLatest } from "./comment-threads";
import type { CommentThread } from "./types";

function note(seenBy?: CommentThread["seenBy"]): CommentThread {
  const thread: CommentThread = {
    id: "n1",
    sessionId: "os-1",
    status: "open",
    createdBy: "Ada",
    ts: 1000,
    updatedAt: 2000,
    comments: [
      { id: "n1", user: "Ada", text: "Can you sign it?", ts: 1000 },
      { id: "c2", user: "Bob", text: "On it", ts: 2000 },
    ],
  };
  if (seenBy) thread.seenBy = seenBy;
  return thread;
}

describe("note read receipts", () => {
  test("only receipts newer than the latest comment count, minus its author", () => {
    const thread = note([
      { user: "Cy", ts: 1500 },
      { user: "Bob", ts: 2100 },
      { user: "Ada", ts: 2200 },
    ]);
    expect(seenLatest(thread).map((s) => s.user)).toEqual(["Ada"]);
  });

  test("a viewer owes a receipt until theirs covers the latest comment", () => {
    expect(needsSeenMark(note(), "Ada")).toBe(true);
    expect(needsSeenMark(note([{ user: "ada", ts: 2000 }]), "Ada")).toBe(false);
    expect(needsSeenMark(note(), "Bob")).toBe(false);
    expect(needsSeenMark(note(), "")).toBe(false);
  });

  test("names read naturally", () => {
    expect(seenByLabel(["Ada"])).toBe("Ada");
    expect(seenByLabel(["Ada", "Bob"])).toBe("Ada and Bob");
    expect(seenByLabel(["Ada", "Bob", "Cy"])).toBe("Ada, Bob and Cy");
    expect(seenByLabel(["Ada", "Bob", "Cy", "Di"])).toBe(
      "Ada, Bob and 2 others",
    );
  });
});
