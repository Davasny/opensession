import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigAsync } from "../../server/config";
import { linearStartMode } from "./start-mode";

const savedConfig = process.env.OPENSESSION_CONFIG;
const savedMode = process.env.LINEAR_START_MODE;
let dir = "";

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "linear-start-mode-"));
  process.env.OPENSESSION_CONFIG = join(dir, "config.json");
  delete process.env.LINEAR_START_MODE;
});

afterEach(() => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  if (savedMode === undefined) delete process.env.LINEAR_START_MODE;
  else process.env.LINEAR_START_MODE = savedMode;
});

let configSeq = 0;

async function configure(startMode: unknown): Promise<void> {
  const path = join(dir, `config-${++configSeq}.json`);
  writeFileSync(
    path,
    JSON.stringify({ integrations: { linear: { startMode } } }),
  );
  process.env.OPENSESSION_CONFIG = path;
  await getConfigAsync();
}

test("unset config keeps the legacy ask mode", async () => {
  writeFileSync(process.env.OPENSESSION_CONFIG!, "{}");
  await getConfigAsync();
  expect(linearStartMode()).toBe("ask");
});

test("config selects plan or implement", async () => {
  await configure("plan");
  expect(linearStartMode()).toBe("plan");
  await configure("implement");
  expect(linearStartMode()).toBe("implement");
});

test("environment wins over config", async () => {
  await configure("plan");
  process.env.LINEAR_START_MODE = "implement";
  expect(linearStartMode()).toBe("implement");
});

test("unknown values fall back to ask", async () => {
  await configure("launch");
  expect(linearStartMode()).toBe("ask");
  process.env.LINEAR_START_MODE = "nonsense";
  expect(linearStartMode()).toBe("ask");
});

test("non-string configured values fail safe with a warning path", async () => {
  await configure(42);
  expect(linearStartMode()).toBe("ask");
  await configure("");
  expect(linearStartMode()).toBe("ask");
});
