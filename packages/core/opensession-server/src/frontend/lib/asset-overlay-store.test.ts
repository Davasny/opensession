import { describe, expect, test } from "bun:test";
import {
  getOpenAssetForTest,
  setOpenAsset,
  syncOpenAssetWithRoute,
} from "./asset-overlay-store";

describe("asset overlay store", () => {
  test("a route naming an asset opens it, and leaving the session drops it", () => {
    syncOpenAssetWithRoute("os-1", "report.html");
    expect(getOpenAssetForTest()).toEqual({
      sessionId: "os-1",
      path: "report.html",
    });
    syncOpenAssetWithRoute("os-1", undefined);
    expect(getOpenAssetForTest()?.path).toBe("report.html");
    syncOpenAssetWithRoute("os-2", undefined);
    expect(getOpenAssetForTest()).toBeNull();
  });

  test("closing another session's overlay leaves this one open", () => {
    setOpenAsset("os-1", "a.html");
    setOpenAsset("os-2", null);
    expect(getOpenAssetForTest()?.path).toBe("a.html");
    setOpenAsset("os-1", null);
    expect(getOpenAssetForTest()).toBeNull();
  });
});
