import { describe, expect, test } from "bun:test";
import { linearAppCredentials, linearAppSchema } from "./linear-apps";

describe("Linear app settings", () => {
  test("blank secrets are omitted so saving preserves existing credentials", () => {
    expect(
      linearAppCredentials({
        name: " Agent ",
        oauthClientId: " client-id ",
        oauthClientSecret: " ",
        webhookSecret: "",
      }),
    ).toEqual({ name: "Agent", oauthClientId: "client-id" });
  });
  test("new credentials are trimmed and included", () => {
    expect(
      linearAppCredentials({
        name: "Agent",
        oauthClientId: "id",
        oauthClientSecret: " client-secret ",
        webhookSecret: " signing-secret ",
      }),
    ).toEqual({
      name: "Agent",
      oauthClientId: "id",
      oauthClientSecret: "client-secret",
      webhookSecret: "signing-secret",
    });
  });
  test("accepts legacy primary and per-app automation configurations", () => {
    const app = {
      id: "primary",
      name: "Primary",
      clientId: "id",
      clientSecretConfigured: true,
      webhookConfigured: true,
      authorizeUrl: "https://example.test/authorize",
      callbackUrl: "https://example.test/callback",
      webhookUrl: "https://example.test/webhook",
      automationEventKey: "linear:agent_session:primary",
      automation: null,
    };
    expect(linearAppSchema.parse(app).automation).toBeNull();
    expect(
      linearAppSchema.parse({
        ...app,
        automation: {
          id: "automation-id",
          prompt: "Review assigned tasks.",
          mode: "scratch",
          model: null,
          repo: null,
          mcpServers: ["linear"],
          mcpAll: false,
          enabled: true,
        },
      }).automation?.mcpServers,
    ).toEqual(["linear"]);
    expect(
      linearAppSchema.parse({
        ...app,
        automation: {
          id: "automation-id",
          prompt: "Review assigned tasks.",
          mode: "scratch",
          model: null,
          repo: null,
          mcpServers: [],
          mcpAll: true,
          enabled: true,
        },
      }).automation?.mcpAll,
    ).toBe(true);
    expect(
      linearAppSchema.safeParse({ ...app, automation: { mode: "unknown" } })
        .success,
    ).toBe(false);
  });
});
