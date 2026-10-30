import { describe, expect, test } from "bun:test";
import { needsSeenMark, seenByLabel, taggedReceipts } from "./comment-threads";
import type { Person } from "./people";
import type { CommentThread } from "./types";

const people: Person[] = [
  { name: "Ada", fullName: "Ada Lovelace" },
  { name: "Bob", fullName: "Bob Ross" },
  { name: "Cy", fullName: "Cy Twombly" },
];

function note(text: string, seenBy?: CommentThread["seenBy"]): CommentThread {
  const thread: CommentThread = {
    id: "n1",
    sessionId: "os-1",
    status: "open",
    createdBy: "Ada",
    ts: 1000,
    updatedAt: 1000,
    comments: [{ id: "n1", user: "Ada", text, ts: 1000 }],
  };
  if (seenBy) thread.seenBy = seenBy;
  return thread;
}

describe("note read receipts", () => {
  test("only people tagged in the newest comment get a receipt", () => {
    expect(taggedReceipts(note("Ship it"), people)).toEqual([]);
    expect(taggedReceipts(note("@Ada and @nobody"), people)).toEqual([]);
    const thread = note("@Bob @cy can you sign it? cc @Bob", [
      { user: "Bob", ts: 1500 },
      { user: "Cy", ts: 900 },
      { user: "Dee", ts: 1600 },
    ]);
    expect(taggedReceipts(thread, people)).toEqual([
      { name: "Bob", seenAt: 1500 },
      { name: "Cy" },
    ]);
  });

  test("only a tagged viewer owes a receipt, until theirs is fresh", () => {
    expect(needsSeenMark(note("@Bob look"), "Bob", people)).toBe(true);
    expect(needsSeenMark(note("@Bob look"), "Cy", people)).toBe(false);
    expect(needsSeenMark(note("look"), "Bob", people)).toBe(false);
    expect(
      needsSeenMark(
        note("@Bob look", [{ user: "bob", ts: 1000 }]),
        "Bob",
        people,
      ),
    ).toBe(false);
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
