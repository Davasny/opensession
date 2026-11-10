import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getConfigAsync } from "./config";
import {
  linearApps,
  linearAppById,
  linearAuthorizePath,
  linearCallbackPath,
  linearRedirectUri,
  linearWebhookPath,
  validAdditionalLinearAppId,
} from "./linear-app-registry";

const savedConfig = process.env.OPENSESSION_CONFIG;
const dir = await mkdtemp(join(tmpdir(), "linear-registry-"));

beforeAll(async () => {
  process.env.OPENSESSION_CONFIG = join(dir, "config.json");
  await writeFile(
    process.env.OPENSESSION_CONFIG,
    JSON.stringify({
      ingress: { publicBaseUrl: "https://hooks.example.test/" },
      integrations: {
        linear: {
          oauthRedirectUrl: "https://override.example.test/callback",
          apps: [
            {
              id: "extra",
              name: "Extra",
              oauthClientId: "client",
              oauthClientSecret: "secret",
              webhookSecret: "webhook",
            },
            { id: "primary", name: "Reserved", oauthClientId: "bad" },
            { id: "extra", name: "Duplicate", oauthClientId: "bad" },
            { id: "../bad", name: "Bad", oauthClientId: "bad" },
          ],
        },
      },
    }),
  );
  await getConfigAsync();
});

afterAll(async () => {
  if (savedConfig === undefined) delete process.env.OPENSESSION_CONFIG;
  else process.env.OPENSESSION_CONFIG = savedConfig;
  await getConfigAsync();
  await rm(dir, { recursive: true, force: true });
});

test("keeps the primary app and skips invalid and duplicate additional ids", () => {
  expect(linearApps().map((app) => app.id)).toEqual(["primary", "extra"]);
  expect(linearAppById("extra")).toMatchObject({
    name: "Extra",
    clientId: "client",
    clientSecret: "secret",
    webhookSecret: "webhook",
  });
  expect(linearAppById("missing")).toBeNull();
  for (const id of ["primary", "../bad", "UPPER", "", "x".repeat(64)])
    expect(validAdditionalLinearAppId(id)).toBe(false);
  expect(validAdditionalLinearAppId("app-2")).toBe(true);
});

test("preserves legacy paths and limits the redirect override to primary", () => {
  expect(linearWebhookPath()).toBe("/webhook");
  expect(linearAuthorizePath()).toBe("/oauth/authorize");
  expect(linearCallbackPath()).toBe("/oauth/callback");
  expect(linearWebhookPath("extra")).toBe("/linear/webhook/extra");
  expect(linearAuthorizePath("extra")).toBe("/linear/oauth/extra/authorize");
  expect(linearCallbackPath("extra")).toBe("/linear/oauth/extra/callback");
  expect(linearRedirectUri(linearApps()[0]!)).toBe(
    "https://override.example.test/callback",
  );
  expect(linearRedirectUri(linearApps()[1]!)).toBe(
    "https://hooks.example.test/linear/oauth/extra/callback",
  );
});
