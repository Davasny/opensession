import { describe, expect, it } from "bun:test";
import {
  getYouShouldKnowUse,
  saveYouShouldKnowUse,
  youShouldKnowUseKey,
} from "./you-should-know-used";

function memoryStorage(initial: Record<string, string> = {}) {
  const data = new Map(Object.entries(initial));
  return {
    getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => void data.set(key, value),
  };
}

describe("you should know used state", () => {
  it("remembers how a note was used and forgets it on undo", () => {
    const storage = memoryStorage();
    const key = youShouldKnowUseKey("s1", "e1");
    expect(getYouShouldKnowUse(key, storage)).toBeUndefined();
    saveYouShouldKnowUse(key, "asked", storage);
    expect(getYouShouldKnowUse(key, storage)).toBe("asked");
    expect(getYouShouldKnowUse(youShouldKnowUseKey("s2", "e1"), storage)).toBe(
      undefined,
    );
    saveYouShouldKnowUse(key, undefined, storage);
    expect(getYouShouldKnowUse(key, storage)).toBeUndefined();
  });

  it("ignores malformed storage", () => {
    const storage = memoryStorage({
      "opensession-you-should-know-used": '{"a":"asked","b":"bogus"',
    });
    expect(getYouShouldKnowUse("a", storage)).toBeUndefined();
    const partial = memoryStorage({
      "opensession-you-should-know-used": '{"a":"known","b":"bogus"}',
    });
    expect(getYouShouldKnowUse("a", partial)).toBe("known");
    expect(getYouShouldKnowUse("b", partial)).toBeUndefined();
  });
});
