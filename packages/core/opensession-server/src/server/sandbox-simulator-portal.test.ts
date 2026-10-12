import { expect, test } from "bun:test";
import {
  sandboxSimulatorAppPath,
  sandboxSupportsSimulatorPortal,
} from "./sandbox-simulator-portal";
import {
  darwinIosToolsInstallScript,
  darwinIosToolsPaths,
  remoteLayoutForProvider,
} from "./sandbox/adapters/bootstrap";
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

test("the macOS iOS tools install is valid bash, locked and logged", async () => {
  const guest = remoteLayoutForProvider("usecomputer");
  const script = darwinIosToolsInstallScript(guest);
  const { log, lock } = darwinIosToolsPaths(guest);
  expect(script).toContain(`>> ${log}`);
  expect(script).toContain(`mkdir ${lock}`);
  expect(script).toContain("brew trust --formula facebook/fb/idb-companion");
  const check = Bun.spawnSync(["bash", "-n", "-c", script]);
  expect(check.exitCode).toBe(0);
});
