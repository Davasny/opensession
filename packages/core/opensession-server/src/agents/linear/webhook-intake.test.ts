import { afterAll, beforeEach, expect, mock, test } from "bun:test";
import { createHmac } from "node:crypto";
import {
  configPath,
  getConfig,
  publishConfigSnapshot,
} from "../../server/config";

const savedConfig = JSON.stringify(getConfig());
const savedSecret = process.env.LINEAR_WEBHOOK_SECRET;
const calls: Array<{ appId: string; token: string | undefined }> = [];
const callbacks: Array<{ appId: string; token: string | undefined }> = [];

mock.module("./handlers", () => ({
  handleAgentSession: async (
    _payload: unknown,
    tokens: Record<string, { accessToken: string }>,
    appId: string,
  ) => {
    calls.push({ appId, token: tokens.org?.accessToken });
    return Response.json({ ok: true });
  },
  handleIssueUpdate: async () => Response.json({ ok: true }),
}));
mock.module("./oauth", () => ({
  getLoadedTokens: () => undefined,
  loadTokens: async (appId: string) => ({
    org: { accessToken: `${appId}-token` },
  }),
  handleAuthorize: (appId: string) => Response.json({ appId }),
  handleCallback: async (
    _req: Request,
    _url: URL,
    tokens: Record<string, { accessToken: string }>,
    appId = "primary",
  ) => {
    callbacks.push({ appId, token: tokens.org?.accessToken });
    return Response.json({ ok: true });
  },
  linearAppIdFromState: (state: string | null) => {
    if (!state) return "primary";
    const separator = state.indexOf(".");
    return separator < 0 ? "primary" : state.slice(0, separator);
  },
}));
mock.module("./session", () => ({
  activeSessions: new Map(),
  loadActiveSessionsOnStartup: async () => {},
}));

const { LinearAgent } = await import("./index");

function configure(extra = true) {
  delete process.env.LINEAR_WEBHOOK_SECRET;
  publishConfigSnapshot(
    configPath(),
    JSON.stringify({
      integrations: {
        linear: {
          webhookSecret: "primary-secret",
          apps: extra
            ? [
                {
                  id: "writer",
                  name: "Writer",
                  oauthClientId: "writer-client",
                  webhookSecret: "writer-secret",
                },
              ]
            : [],
        },
      },
    }),
  );
}

beforeEach(() => {
  configure();
  calls.length = 0;
  callbacks.length = 0;
});

afterAll(() => {
  publishConfigSnapshot(configPath(), savedConfig);
  if (savedSecret === undefined) delete process.env.LINEAR_WEBHOOK_SECRET;
  else process.env.LINEAR_WEBHOOK_SECRET = savedSecret;
  mock.restore();
});

const payload = {
  type: "AgentSessionEvent",
  action: "created",
  organizationId: "org",
  agentSession: {
    id: "session-1",
    status: "active",
    issue: {
      id: "issue-1",
      identifier: "ENG-1",
      title: "Write a guide",
      url: "https://linear.app/acme/issue/ENG-1",
    },
  },
};

function signed(path: string, secret: string, value: unknown = payload) {
  const body = JSON.stringify(value);
  return new Request(`https://hooks.example.test${path}`, {
    method: "POST",
    body,
    headers: {
      "linear-signature": createHmac("sha256", secret)
        .update(body)
        .digest("hex"),
    },
  });
}

async function deliver(
  agent: InstanceType<typeof LinearAgent>,
  path: string,
  secret: string,
  value: unknown = payload,
) {
  const route = agent
    .getRoutes()
    .get(path === "/webhook" ? "POST /webhook" : "POST /linear/webhook/*");
  if (!route) throw new Error("Webhook route missing");
  const request = signed(path, secret, value);
  return route(request, new URL(request.url));
}

test("each app verifies only its own webhook secret and receives its own grant", async () => {
  const agent = new LinearAgent();
  expect(
    (await deliver(agent, "/linear/webhook/writer", "primary-secret")).status,
  ).toBe(401);
  expect((await deliver(agent, "/webhook", "writer-secret")).status).toBe(401);
  expect(calls).toEqual([]);
  expect(
    (await deliver(agent, "/linear/webhook/writer", "writer-secret")).status,
  ).toBe(200);
  expect((await deliver(agent, "/webhook", "primary-secret")).status).toBe(200);
  expect(calls).toEqual([
    { appId: "writer", token: "writer-token" },
    { appId: "primary", token: "primary-token" },
  ]);
});

test("unknown or malformed app paths never fall back to the primary app", async () => {
  const agent = new LinearAgent();
  for (const path of [
    "/linear/webhook/unknown",
    "/linear/webhook/primary",
    "/linear/webhook/writer/extra",
  ])
    expect((await deliver(agent, path, "primary-secret")).status).toBe(404);
  expect(calls).toEqual([]);
});

test("apps added after route registration work without a connector restart", async () => {
  configure(false);
  const routes = new LinearAgent().getRoutes();
  configure();
  const route = routes.get("POST /linear/webhook/*");
  if (!route) throw new Error("Webhook route missing");
  const request = signed("/linear/webhook/writer", "writer-secret");
  expect((await route(request, new URL(request.url))).status).toBe(200);
  expect(calls[0]?.appId).toBe("writer");
});

test("the shared callback selects the app named in the OAuth state", async () => {
  const route = new LinearAgent().getRoutes().get("GET /oauth/callback");
  if (!route) throw new Error("OAuth callback route missing");
  const request = new Request(
    "https://hooks.example.test/oauth/callback?code=code&state=writer.nonce",
  );
  expect((await route(request, new URL(request.url))).status).toBe(200);
  expect(callbacks).toEqual([{ appId: "writer", token: "writer-token" }]);
});

test("an unknown app in the OAuth state does not fall back to primary", async () => {
  const route = new LinearAgent().getRoutes().get("GET /oauth/callback");
  if (!route) throw new Error("OAuth callback route missing");
  const request = new Request(
    "https://hooks.example.test/oauth/callback?code=code&state=unknown.nonce",
  );
  expect((await route(request, new URL(request.url))).status).toBe(404);
  expect(callbacks).toEqual([]);
});

test("signed malformed events are rejected before lifecycle handlers", async () => {
  const response = await deliver(
    new LinearAgent(),
    "/linear/webhook/writer",
    "writer-secret",
    { type: "AgentSessionEvent", action: "created" },
  );
  expect(response.status).toBe(400);
  expect(calls).toEqual([]);
});
