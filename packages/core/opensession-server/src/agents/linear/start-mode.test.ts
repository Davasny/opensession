import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigAsync } from "../../server/config";
import { linearAppStartMode, linearStartModeFor } from "./start-mode";

const savedConfig = process.env.OPENSESSION_CONFIG;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "linear-start-mode-"));
  process.env.OPENSESSION_CONFIG = join(dir, "config.json");
});

afterEach(() => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
});

let configSeq = 0;

async function configure(linear: Record<string, unknown>): Promise<void> {
  const path = join(dir, `config-${++configSeq}.json`);
  writeFileSync(path, JSON.stringify({ integrations: { linear } }));
  process.env.OPENSESSION_CONFIG = path;
  await getConfigAsync();
}

test("an unset app keeps the legacy ask mode", async () => {
  await configure({});
  expect(linearAppStartMode("primary")).toBe("ask");
});

test("each app keeps its own mode", async () => {
  await configure({
    startMode: "plan",
    apps: [
      {
        id: "extra",
        name: "Extra",
        oauthClientId: "extra-client",
        startMode: "implement",
      },
    ],
  });
  expect(linearAppStartMode("primary")).toBe("plan");
  expect(linearAppStartMode("extra")).toBe("implement");
  expect(linearAppStartMode("missing")).toBe("ask");
});

test("unknown values fall back to ask", async () => {
  await configure({ startMode: "launch" });
  expect(linearAppStartMode("primary")).toBe("ask");
});

test("non-string configured values fail safe", async () => {
  await configure({ startMode: 42 });
  expect(linearAppStartMode("primary")).toBe("ask");
  await configure({ startMode: "" });
  expect(linearAppStartMode("primary")).toBe("ask");
});

test("the legacy global environment variable is ignored", async () => {
  const savedMode = process.env.LINEAR_START_MODE;
  process.env.LINEAR_START_MODE = "implement";
  try {
    await configure({ startMode: "plan" });
    expect(linearAppStartMode("primary")).toBe("plan");
  } finally {
    if (savedMode === undefined) delete process.env.LINEAR_START_MODE;
    else process.env.LINEAR_START_MODE = savedMode;
  }
});

test("non-coding task modes always start implementation", async () => {
  await configure({ startMode: "plan" });
  expect(linearStartModeFor("primary", "scratch")).toBe("implement");
  expect(linearStartModeFor("primary", "ask")).toBe("implement");
  expect(linearStartModeFor("primary", "code")).toBe("plan");
  expect(linearStartModeFor("primary", undefined)).toBe("plan");
});
