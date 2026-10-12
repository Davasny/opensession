import { describe, expect, it } from "bun:test";
import {
  DOUBLE_TAP_MS,
  ghostSuffix,
  isDoubleTap,
  takesPrediction,
  wantsCompletion,
} from "./composer-prediction";

const tab = {
  key: "Tab",
  shiftKey: false,
  metaKey: false,
  ctrlKey: false,
  altKey: false,
};

describe("takesPrediction", () => {
  it("takes a bare Tab in an empty composer", () => {
    expect(takesPrediction(tab, "", "ship it")).toBe(true);
    expect(takesPrediction(tab, "  ", "ship it")).toBe(true);
  });

  it("leaves Tab alone with a draft, no prediction, or a modifier", () => {
    expect(takesPrediction(tab, "hi", "ship it")).toBe(false);
    expect(takesPrediction(tab, "", null)).toBe(false);
    expect(takesPrediction({ ...tab, shiftKey: true }, "", "ship it")).toBe(
      false,
    );
    expect(takesPrediction({ ...tab, key: "Enter" }, "", "ship it")).toBe(
      false,
    );
  });
});

describe("ghostSuffix", () => {
  const s = { base: "fix both but", completion: " add tests first" };

  it("shows the rest of the suggestion ahead of the draft", () => {
    expect(ghostSuffix("fix both but", s)).toBe(" add tests first");
  });

  it("survives typing through it and shrinks", () => {
    expect(ghostSuffix("fix both but add", s)).toBe(" tests first");
  });

  it("retires on a mismatch, a deletion, or once fully typed", () => {
    expect(ghostSuffix("fix both but skip", s)).toBeNull();
    expect(ghostSuffix("fix both bu", s)).toBeNull();
    expect(ghostSuffix("fix both but add tests first", s)).toBeNull();
    expect(ghostSuffix("anything", null)).toBeNull();
  });
});

describe("isDoubleTap", () => {
  it("needs two close taps in quick succession", () => {
    const a = { t: 0, x: 10, y: 10 };
    expect(isDoubleTap(null, a)).toBe(false);
    expect(isDoubleTap(a, { t: 200, x: 14, y: 12 })).toBe(true);
    expect(isDoubleTap(a, { t: DOUBLE_TAP_MS + 1, x: 10, y: 10 })).toBe(false);
    expect(isDoubleTap(a, { t: 100, x: 200, y: 10 })).toBe(false);
  });
});

describe("wantsCompletion", () => {
  it("skips short drafts and finished sentences", () => {
    expect(wantsCompletion("a")).toBe(false);
    expect(wantsCompletion("is it final?")).toBe(false);
    expect(wantsCompletion("ok. ")).toBe(false);
    expect(wantsCompletion("fix the bu")).toBe(true);
  });
});
