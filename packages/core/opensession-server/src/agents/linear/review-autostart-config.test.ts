import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigAsync } from "../../server/config";
import { linearReviewAutostartConfig } from "./review-autostart-config";

const ENV_KEYS = [
  "OPENSESSION_CONFIG",
  "LINEAR_REVIEW_AUTOSTART",
  "LINEAR_REVIEW_AUTOSTART_ROUNDS",
  "LINEAR_REVIEW_AUTOSTART_REVIEWERS",
] as const;

const saved = Object.fromEntries(
  ENV_KEYS.map((key) => [key, process.env[key]]),
) as Record<(typeof ENV_KEYS)[number], string | undefined>;

let dir = "";
let configSeq = 0;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "linear-review-autostart-"));
  process.env.OPENSESSION_CONFIG = join(dir, "config.json");
  for (const key of ENV_KEYS.slice(1)) delete process.env[key];
});

afterEach(() => {
  for (const key of ENV_KEYS) {
    if (saved[key] === undefined) delete process.env[key];
    else process.env[key] = saved[key];
  }
});

async function configure(linear: Record<string, unknown>): Promise<void> {
  const path = join(dir, `config-${++configSeq}.json`);
  writeFileSync(path, JSON.stringify({ integrations: { linear } }));
  process.env.OPENSESSION_CONFIG = path;
  await getConfigAsync();
}

test("defaults to off with four trusted rounds", async () => {
  writeFileSync(process.env.OPENSESSION_CONFIG!, "{}");
  await getConfigAsync();
  expect(linearReviewAutostartConfig()).toEqual({
    enabled: false,
    rounds: 4,
    reviewers: "trusted",
  });
});

test("config opts in and sets the cap and reviewer mode", async () => {
  await configure({
    reviewAutostart: "changes-requested",
    reviewAutostartRounds: 3,
    reviewAutostartReviewers: "any-write",
  });
  expect(linearReviewAutostartConfig()).toEqual({
    enabled: true,
    rounds: 3,
    reviewers: "any-write",
  });
});

test("a boolean enables the feature", async () => {
  await configure({ reviewAutostart: true });
  expect(linearReviewAutostartConfig().enabled).toBe(true);
});

test("environment overrides config", async () => {
  await configure({
    reviewAutostart: "off",
    reviewAutostartRounds: 2,
    reviewAutostartReviewers: "trusted",
  });
  process.env.LINEAR_REVIEW_AUTOSTART = "changes-requested";
  process.env.LINEAR_REVIEW_AUTOSTART_ROUNDS = "6";
  process.env.LINEAR_REVIEW_AUTOSTART_REVIEWERS = "any";
  expect(linearReviewAutostartConfig()).toEqual({
    enabled: true,
    rounds: 6,
    reviewers: "any-write",
  });
});

test("unknown and malformed values fail safe", async () => {
  await configure({
    reviewAutostart: "maybe",
    reviewAutostartRounds: "lots",
    reviewAutostartReviewers: "everyone",
  });
  expect(linearReviewAutostartConfig()).toEqual({
    enabled: false,
    rounds: 4,
    reviewers: "trusted",
  });
});

test("the round cap is clamped", async () => {
  await configure({ reviewAutostart: true, reviewAutostartRounds: 99 });
  expect(linearReviewAutostartConfig().rounds).toBe(10);
});
