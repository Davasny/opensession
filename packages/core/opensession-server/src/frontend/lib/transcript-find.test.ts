import { describe, expect, test } from "bun:test";
import type { TranscriptEntry } from "./types";
import {
  findableText,
  findTranscriptMatches,
  normalizeFindQuery,
  stepFindIndex,
} from "./transcript-find";

function entry(
  patch: Partial<TranscriptEntry> & Pick<TranscriptEntry, "id">,
): TranscriptEntry {
  return {
    type: "user",
    content: "",
    timestamp: "2026-10-13T10:00:00.000Z",
    ...patch,
  };
}

describe("findTranscriptMatches", () => {
  test("counts every occurrence in messages and replies, oldest first", () => {
    const matches = findTranscriptMatches(
      [
        entry({ id: "a", content: "Rename the Widget and the widget test" }),
        entry({ id: "b", type: "assistant", content: "Renamed **widget**." }),
        entry({ id: "c", type: "tool_use", content: "widget widget" }),
        entry({ id: "d", content: "Thanks" }),
      ],
      "widget",
    );
    expect(matches).toEqual([
      { entryId: "a", occurrence: 0 },
      { entryId: "a", occurrence: 1 },
      { entryId: "b", occurrence: 0 },
    ]);
  });

  test("an empty or blank query matches nothing", () => {
    const entries = [entry({ id: "a", content: "anything" })];
    expect(findTranscriptMatches(entries, "")).toEqual([]);
    expect(findTranscriptMatches(entries, "   ")).toEqual([]);
  });

  test("stops at the limit", () => {
    const entries = [entry({ id: "a", content: "x ".repeat(50) })];
    expect(findTranscriptMatches(entries, "x", 10)).toHaveLength(10);
  });

  test("matches across collapsed whitespace", () => {
    const matches = findTranscriptMatches(
      [entry({ id: "a", content: "open the\n\nfind bar" })],
      "the find",
    );
    expect(matches).toHaveLength(1);
  });
});

describe("findableText", () => {
  test("drops markdown a reader never sees", () => {
    expect(
      findableText(
        entry({
          id: "a",
          type: "assistant",
          content: "See [the docs](https://example.test) and `bun run check`",
        }),
      ),
    ).toBe("See the docs and bun run check");
  });

  test("skips reasoning, notices and tool rows", () => {
    expect(
      findableText(
        entry({ id: "a", type: "assistant", content: "x", isReasoning: true }),
      ),
    ).toBeNull();
    expect(
      findableText(entry({ id: "b", content: "[GitHub] PR #12 merged" })),
    ).toBeNull();
    expect(
      findableText(entry({ id: "c", type: "tool_use", content: "x" })),
    ).toBeNull();
  });

  test("a teammate's message is searched without its delivery prefix", () => {
    expect(
      findableText(entry({ id: "a", content: "[Kent] use the light theme" })),
    ).toBe("use the light theme");
  });
});

test("normalizeFindQuery lowercases and collapses whitespace", () => {
  expect(normalizeFindQuery("  Find\tMe ")).toBe(" find me ");
  expect(normalizeFindQuery(" ")).toBeNull();
});

test("stepFindIndex wraps at both ends", () => {
  expect(stepFindIndex(0, 3, -1)).toBe(2);
  expect(stepFindIndex(2, 3, 1)).toBe(0);
  expect(stepFindIndex(1, 3, 1)).toBe(2);
  expect(stepFindIndex(0, 0, 1)).toBe(0);
});
