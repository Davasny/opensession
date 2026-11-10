import { afterAll, beforeAll, expect, spyOn, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RouteContext } from "./context";

const savedEnv = { ...process.env };
const dir = await mkdtemp(join(tmpdir(), "linear-apps-"));
process.env.OPENSESSION_STATE_DIR = dir;
process.env.OPENSESSION_CONFIG = join(dir, "config.json");
process.env.OPENSESSION_MCP_CONFIG = join(dir, "mcp.json");
delete process.env.LINEAR_CLIENT_ID;
delete process.env.LINEAR_CLIENT_SECRET;
delete process.env.LINEAR_WEBHOOK_SECRET;
delete process.env.OPENSESSION_GITHUB_USER_PR_AUTH;
delete process.env.OPENSESSION_GITHUB_CLIENT_ID;

const { getConfigAsync } = await import("../config");
const { handleLinearAppsRoutes } = await import("./linear-apps");
const {
  linearApps,
  linearAppById,
  validAdditionalLinearAppId,
  linearWebhookPath,
  linearAuthorizePath,
  linearCallbackPath,
  linearRedirectUri,
} = await import("../linear-app-registry");

function context(
  path: string,
  method = "GET",
  body?: unknown,
  authUser: RouteContext["authUser"] = null,
): RouteContext {
  const url = new URL(`http://localhost${path}`);
  return {
    req: new Request(url, {
      method,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }),
    path,
    url,
    publicPrefix: "",
    authUser,
  };
}
const path = "/api/connections/linear/apps";

beforeAll(async () => {
  await writeFile(join(dir, "mcp.json"), JSON.stringify({ mcpServers: {} }));
  await writeFile(
    join(dir, "config.json"),
    JSON.stringify({
      ingress: { publicBaseUrl: "https://hooks.example.test/" },
      integrations: {
        linear: {
          oauthClientId: "primary-client",
          oauthClientSecret: "primary-secret",
          webhookSecret: "primary-webhook",
          oauthRedirectUrl: "https://callback.example.test/oauth/callback",
          apps: [
            {
              id: "extra",
              name: "Extra",
              oauthClientId: "extra-client",
              oauthClientSecret: "extra-secret",
              webhookSecret: "extra-webhook",
            },
            { id: "primary", name: "Reserved", oauthClientId: "bad" },
            { id: "extra", name: "Duplicate", oauthClientId: "bad" },
            { id: "../bad", name: "Bad", oauthClientId: "bad" },
            { id: "incomplete", name: "Incomplete" },
          ],
        },
      },
    }),
  );
  await getConfigAsync();
});

afterAll(async () => {
  for (const key of Object.keys(process.env))
    if (!(key in savedEnv)) delete process.env[key];
  Object.assign(process.env, savedEnv);
  await getConfigAsync();
  await rm(dir, { recursive: true, force: true });
});

test("registry skips invalid, reserved, incomplete, and duplicate entries", () => {
  expect(linearApps().map((app) => app.id)).toEqual(["primary", "extra"]);
  expect(linearAppById("missing")).toBeNull();
  expect(validAdditionalLinearAppId("primary")).toBe(false);
  expect(validAdditionalLinearAppId("a-b2")).toBe(true);
  expect(validAdditionalLinearAppId("A")).toBe(false);
  expect(validAdditionalLinearAppId("x".repeat(64))).toBe(false);
});

test("primary env credentials win while extra app credentials remain independent", () => {
  process.env.LINEAR_CLIENT_ID = "env-client";
  process.env.LINEAR_CLIENT_SECRET = "env-secret";
  process.env.LINEAR_WEBHOOK_SECRET = "env-webhook";
  expect(linearAppById("primary")).toMatchObject({
    clientId: "env-client",
    clientSecret: "env-secret",
    webhookSecret: "env-webhook",
  });
  expect(linearAppById("extra")?.clientSecret).toBe("extra-secret");
  delete process.env.LINEAR_CLIENT_ID;
  delete process.env.LINEAR_CLIENT_SECRET;
  delete process.env.LINEAR_WEBHOOK_SECRET;
  expect(linearAppById("primary")?.clientSecret).toBe("primary-secret");
});

test("paths preserve the primary endpoints and redirect override", () => {
  expect(linearWebhookPath()).toBe("/webhook");
  expect(linearAuthorizePath()).toBe("/oauth/authorize");
  expect(linearCallbackPath()).toBe("/oauth/callback");
  expect(linearWebhookPath("extra")).toBe("/linear/webhook/extra");
  expect(linearAuthorizePath("extra")).toBe("/linear/oauth/extra/authorize");
  expect(linearCallbackPath("extra")).toBe("/linear/oauth/extra/callback");
  expect(linearRedirectUri(linearApps()[0]!)).toBe(
    "https://callback.example.test/oauth/callback",
  );
  expect(linearRedirectUri(linearApps()[1]!)).toBe(
    "https://hooks.example.test/linear/oauth/extra/callback",
  );
});

test("GET is sanitized and reports legacy primary without automation", async () => {
  const response = await handleLinearAppsRoutes(context(path));
  expect(response?.status).toBe(200);
  const text = await response!.text();
  for (const secret of [
    "primary-secret",
    "primary-webhook",
    "extra-secret",
    "extra-webhook",
  ])
    expect(text).not.toContain(secret);
  expect(JSON.parse(text).apps[0]).toMatchObject({
    id: "primary",
    clientId: "primary-client",
    clientSecretConfigured: true,
    webhookConfigured: true,
    automationEventKey: "linear:agent_session:primary",
    automation: null,
  });
});

test("rejects automations, malformed input, reserved deletion, and privileged automation options", async () => {
  for (const method of ["GET", "POST", "PUT", "DELETE"]) {
    expect(
      (
        await handleLinearAppsRoutes(
          context(path, method, undefined, {
            login: "bot",
            name: "Bot",
            automation: true,
          }),
        )
      )?.status,
    ).toBe(403);
  }
  expect(
    (await handleLinearAppsRoutes(context(`${path}/primary`, "DELETE")))
      ?.status,
  ).toBe(400);
  expect(
    (
      await handleLinearAppsRoutes(
        context(path, "POST", { name: "Missing id" }),
      )
    )?.status,
  ).toBe(400);
  expect(
    (
      await handleLinearAppsRoutes(
        context(`${path}/primary`, "PUT", { automation: { mcpRunAs: "acme" } }),
      )
    )?.status,
  ).toBe(400);
  expect(
    (
      await handleLinearAppsRoutes(
        context(`${path}/primary`, "PUT", { automation: { mode: "invalid" } }),
      )
    )?.status,
  ).toBe(400);
  expect(
    (
      await handleLinearAppsRoutes(
        context(`${path}/unknown`, "PUT", { name: "Unknown" }),
      )
    )?.status,
  ).toBe(404);
});

test("creates an app with a scoped scratch automation, updates it, then removes only the app", async () => {
  const created = await handleLinearAppsRoutes(
    context(path, "POST", {
      name: "Tasks",
      oauthClientId: "new-client",
      oauthClientSecret: "new-secret",
      webhookSecret: "new-webhook",
    }),
  );
  expect(created?.status).toBe(201);
  const { app } = await created!.json();
  expect(validAdditionalLinearAppId(app.id)).toBe(true);
  expect(app.automation).toMatchObject({
    mode: "scratch",
    mcpServers: [],
    enabled: true,
  });
  expect(app.automationEventKey).toBe(`linear:agent_session:${app.id}`);
  const updated = await handleLinearAppsRoutes(
    context(`${path}/${app.id}`, "PUT", {
      name: "Renamed",
      automation: {
        prompt: "Handle this task.",
        mode: "ask",
        enabled: false,
        mcpServers: [],
      },
    }),
  );
  expect(updated?.status).toBe(200);
  expect((await updated!.json()).app).toMatchObject({
    name: "Renamed",
    clientSecretConfigured: true,
    automation: {
      id: app.automation.id,
      prompt: "Handle this task.",
      mode: "ask",
      enabled: false,
    },
  });
  const listed = await handleLinearAppsRoutes(context(path));
  const listedApp = (await listed!.json()).apps.find(
    (entry: { id: string }) => entry.id === app.id,
  );
  expect(listedApp.automation.id).toBe(app.automation.id);
  expect(
    (await handleLinearAppsRoutes(context(`${path}/${app.id}`, "DELETE")))
      ?.status,
  ).toBe(200);
  expect(linearAppById(app.id)).toBeNull();
  const raw = JSON.parse(await readFile(join(dir, "config.json"), "utf8"));
  expect(raw.integrations.linear.oauthClientSecret).toBe("primary-secret");
});

test("primary automation is created only on explicit request", async () => {
  const response = await handleLinearAppsRoutes(
    context(`${path}/primary`, "PUT", {
      automation: { prompt: "Primary task.", mcpServers: [], mode: "scratch" },
    }),
  );
  expect(response?.status).toBe(200);
  expect((await response!.json()).app.automation).toMatchObject({
    prompt: "Primary task.",
    mode: "scratch",
    mcpServers: [],
  });
});

test("concurrent app writes preserve both entries", async () => {
  const results = await Promise.all(
    ["One", "Two"].map((name) =>
      handleLinearAppsRoutes(
        context(path, "POST", { name, oauthClientId: name }),
      ),
    ),
  );
  expect(results.map((response) => response?.status)).toEqual([201, 201]);
  expect(linearApps().map((app) => app.name)).toEqual(
    expect.arrayContaining(["One", "Two"]),
  );
});

test("keeps configured client identity immutable while allowing secret rotation", async () => {
  expect(
    (
      await handleLinearAppsRoutes(
        context(`${path}/extra`, "PUT", { oauthClientId: "replacement" }),
      )
    )?.status,
  ).toBe(409);
  expect(
    (
      await handleLinearAppsRoutes(
        context(`${path}/primary`, "PUT", { oauthClientId: "replacement" }),
      )
    )?.status,
  ).toBe(409);
  expect(linearAppById("extra")?.clientId).toBe("extra-client");
  expect(
    (
      await handleLinearAppsRoutes(
        context(`${path}/extra`, "PUT", {
          oauthClientSecret: "rotated-secret",
        }),
      )
    )?.status,
  ).toBe(200);
  expect(linearAppById("extra")?.clientSecret).toBe("rotated-secret");
});

test("rejects primary credential writes shadowed by environment values", async () => {
  process.env.LINEAR_CLIENT_ID = "env-client";
  process.env.LINEAR_CLIENT_SECRET = "env-secret";
  process.env.LINEAR_WEBHOOK_SECRET = "env-webhook";
  for (const field of ["oauthClientId", "oauthClientSecret", "webhookSecret"]) {
    expect(
      (
        await handleLinearAppsRoutes(
          context(`${path}/primary`, "PUT", { [field]: "replacement" }),
        )
      )?.status,
    ).toBe(409);
  }
  delete process.env.LINEAR_CLIENT_ID;
  delete process.env.LINEAR_CLIENT_SECRET;
  delete process.env.LINEAR_WEBHOOK_SECRET;
});

test("blank secrets preserve stored values and unchanged env credentials are accepted", async () => {
  const before = linearAppById("extra");
  expect(
    (
      await handleLinearAppsRoutes(
        context(`${path}/extra`, "PUT", {
          oauthClientId: "extra-client",
          oauthClientSecret: " ",
          webhookSecret: "",
        }),
      )
    )?.status,
  ).toBe(200);
  expect(linearAppById("extra")).toEqual(before);
  process.env.LINEAR_CLIENT_ID = "env-client";
  process.env.LINEAR_CLIENT_SECRET = "env-secret";
  process.env.LINEAR_WEBHOOK_SECRET = "env-webhook";
  try {
    expect(
      (
        await handleLinearAppsRoutes(
          context(`${path}/primary`, "PUT", {
            oauthClientId: "env-client",
            oauthClientSecret: "",
            webhookSecret: " ",
          }),
        )
      )?.status,
    ).toBe(200);
    expect(
      (
        await handleLinearAppsRoutes(
          context(`${path}/primary`, "PUT", {
            oauthClientId: "env-client",
            oauthClientSecret: "env-secret",
            webhookSecret: "env-webhook",
          }),
        )
      )?.status,
    ).toBe(200);
    const stored = JSON.parse(await readFile(join(dir, "config.json"), "utf8"))
      .integrations.linear;
    expect(stored.oauthClientId).toBe("primary-client");
    expect(stored.oauthClientSecret).toBe("primary-secret");
    expect(stored.webhookSecret).toBe("primary-webhook");
  } finally {
    delete process.env.LINEAR_CLIENT_ID;
    delete process.env.LINEAR_CLIENT_SECRET;
    delete process.env.LINEAR_WEBHOOK_SECRET;
  }
});

test("bounds submitted fields and streamed body bytes", async () => {
  for (const body of [
    { name: "x".repeat(201) },
    { oauthClientId: "x".repeat(1025) },
    { oauthClientSecret: "x".repeat(8193) },
    { webhookSecret: "x".repeat(8193) },
    { automation: { prompt: "x".repeat(65537) } },
  ]) {
    expect(
      (await handleLinearAppsRoutes(context(`${path}/primary`, "PUT", body)))
        ?.status,
    ).toBe(400);
  }
  expect(
    (
      await handleLinearAppsRoutes(
        context(`${path}/primary`, "PUT", { name: "x".repeat(128 * 1024) }),
      )
    )?.status,
  ).toBe(413);
});

test("restores prior automation fields when config persistence fails", async () => {
  const beforeResponse = await handleLinearAppsRoutes(context(path));
  const before = (await beforeResponse!.json()).apps.find(
    (app: { id: string }) => app.id === "primary",
  );
  const mutations = await import("../config-mutation");
  const persist = spyOn(
    mutations,
    "persistRawConfigAsync",
  ).mockRejectedValueOnce(new Error("Injected persistence failure"));
  try {
    const response = await handleLinearAppsRoutes(
      context(`${path}/primary`, "PUT", {
        name: "Not saved",
        automation: {
          prompt: "Should roll back.",
          enabled: false,
          mode: "ask",
        },
      }),
    );
    expect(response?.status).toBe(500);
  } finally {
    persist.mockRestore();
  }
  const afterResponse = await handleLinearAppsRoutes(context(path));
  const after = (await afterResponse!.json()).apps.find(
    (app: { id: string }) => app.id === "primary",
  );
  expect(after).toEqual(before);
});

test("removes a newly seeded automation when app persistence fails", async () => {
  const { listAutomations } = await import("../automations");
  const before = (await listAutomations()).map((automation) => automation.id);
  const mutations = await import("../config-mutation");
  const persist = spyOn(
    mutations,
    "persistRawConfigAsync",
  ).mockRejectedValueOnce(new Error("Injected persistence failure"));
  try {
    expect(
      (
        await handleLinearAppsRoutes(
          context(path, "POST", {
            name: "Failed creation",
            oauthClientId: "failed-client",
          }),
        )
      )?.status,
    ).toBe(500);
  } finally {
    persist.mockRestore();
  }
  expect((await listAutomations()).map((automation) => automation.id)).toEqual(
    before,
  );
  expect(linearApps().some((app) => app.name === "Failed creation")).toBe(
    false,
  );
});

test("requires a signed-in person when web authentication is enabled", async () => {
  const configPath = join(dir, "config.json");
  const raw = JSON.parse(await readFile(configPath, "utf8"));
  raw.integrations.github = {
    userPrAuth: true,
    oauthClientId: "github-client",
  };
  await writeFile(configPath, JSON.stringify(raw));
  await getConfigAsync();
  expect((await handleLinearAppsRoutes(context(path)))?.status).toBe(403);
  expect(
    (
      await handleLinearAppsRoutes(
        context(path, "GET", undefined, { login: "acme", name: "Acme" }),
      )
    )?.status,
  ).toBe(200);
});
