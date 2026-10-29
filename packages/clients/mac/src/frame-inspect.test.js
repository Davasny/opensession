const { describe, expect, test } = require("bun:test");
const { FRAME_INSPECT_SCRIPT, captureRect } = require("./frame-inspect");

describe("frame inspect", () => {
  test("the responder is a self-contained script", () => {
    expect(() => new Function(FRAME_INSPECT_SCRIPT)).not.toThrow();
    expect(FRAME_INSPECT_SCRIPT).toContain("opensession:inspected");
  });

  test("capture rectangles scale by zoom and refuse junk", () => {
    expect(captureRect({ x: 10, y: 20, width: 300, height: 200 }, 1.5)).toEqual(
      { x: 15, y: 30, width: 450, height: 300 },
    );
    expect(captureRect({ x: 0, y: 0, width: 0, height: 10 }, 1)).toBeNull();
    expect(captureRect({ x: "a", y: 0, width: 1, height: 1 }, 1)).toBeNull();
    expect(captureRect(null, 1)).toBeNull();
  });
});
