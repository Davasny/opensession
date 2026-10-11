import { expect, test } from "bun:test";
import {
  sandboxSimulatorAppPath,
  sandboxSupportsSimulatorPortal,
} from "./sandbox-simulator-portal";
import type { Sandbox } from "./sandbox/provider";

test("simulator app paths stay inside the Sandbox workspace", () => {
  expect(sandboxSimulatorAppPath("build/sim/App.app")).toBe(
    "build/sim/App.app",
  );
  expect(sandboxSimulatorAppPath("./a/../App.app")).toBe("App.app");
  for (const bad of [
    "/Users/x/App.app",
    "../App.app",
    "a/../../App.app",
    "App.ipa",
  ])
    expect(() => sandboxSimulatorAppPath(bad)).toThrow();
});

test("only macOS Sandboxes run simulator Portals", () => {
  const sandbox = (provider: string) => ({ provider }) as Sandbox;
  expect(sandboxSupportsSimulatorPortal(sandbox("usecomputer"))).toBe(true);
  expect(sandboxSupportsSimulatorPortal(sandbox("tart"))).toBe(true);
  expect(sandboxSupportsSimulatorPortal(sandbox("daytona"))).toBe(false);
});
