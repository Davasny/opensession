import { describe, expect, test } from "bun:test";
import type { Automation } from "./automations";
import type { LinearSessionSource } from "./agent-session-catalog";
import type { LinearSessionFile } from "./types";
import { linearSessionRunInputs } from "./linear-session-run-inputs";

function fixture(fields: Partial<LinearSessionFile> = {}) {
  const source: LinearSessionSource = {
    file: "agent-session.json",
    mtime: "2026-01-01T00:00:00.000Z",
    data: {
      branch: "acme-task",
      claudeSessionId: null,
      appId: "acme",
      organizationId: "acme-org",
      automationId: "acme-agent",
      executionMode: "ask",
      ...fields,
    },
  };
  const config: Automation = {
    id: "acme-agent",
    name: "Acme agent",
    prompt: "Follow the configured task workflow.",
    model: "pi/example-model",
    effort: "high",
    mode: "code",
    schedule: "",
    enabled: true,
    createdBy: "Alice",
    createdAt: source.mtime,
    webhookSecret: "example-secret",
    mcpServers: ["linear-acme"],
  };
  const tokenCalls: string[][] = [];
  const sourceKeys: string[] = [];
  const deps = {
    source: async (key: string) => {
      sourceKeys.push(key);
      return source;
    },
    config: async (_appId: string): Promise<Automation | null> => config,
    app: (appId: string) => ({
      id: appId,
      name: "Acme",
      clientId: "example-client",
      clientSecret: "example-secret",
      webhookSecret: "example-secret",
    }),
    token: async (appId: string, organizationId: string) => {
      tokenCalls.push([appId, organizationId]);
      return true;
    },
  };
  const session = {
    id: "linear-agent-session",
    source: "linear" as const,
    model: undefined,
    mode: "code" as const,
  };
  return { source, config, deps, session, tokenCalls, sourceKeys };
}

describe("Linear UI turn configuration", () => {
  test("reads one source and keeps its profile, locked mode, and app/org grant", async () => {
    const f = fixture();
    const result = await linearSessionRunInputs(f.session, f.deps);
    expect(result).toEqual({
      mode: "ask",
      model: f.config.model,
      effort: "high",
      instructions: f.config.prompt,
      mcpServers: ["linear-acme"],
      linearGrant: { appId: "acme", organizationId: "acme-org" },
    });
    expect(f.sourceKeys).toEqual(["agent-session"]);
    expect(f.tokenCalls).toEqual([["acme", "acme-org"]]);
    expect(JSON.stringify(result)).not.toContain("example-secret");
  });

  test("keeps scratch and code modes and the session's chosen model", async () => {
    for (const executionMode of ["scratch", "code"] as const) {
      const f = fixture({ executionMode, model: "pi/session-model" });
      const result = await linearSessionRunInputs(f.session, f.deps);
      expect(result?.mode).toBe(executionMode);
      expect(result?.model).toBe("pi/session-model");
    }
  });

  test("an omitted or empty profile allowlist never becomes all servers", async () => {
    const f = fixture();
    delete f.config.mcpServers;
    expect(
      (await linearSessionRunInputs(f.session, f.deps))?.mcpServers,
    ).toEqual([]);
  });

  test("an explicit all-connectors profile uses every configured server", async () => {
    const f = fixture();
    f.config.mcpAll = true;
    expect((await linearSessionRunInputs(f.session, f.deps))?.mcpServers).toBe(
      "all",
    );
  });

  test("refuses disabled, deleted, or replaced profiles before issuing credentials", async () => {
    const f = fixture();
    f.config.enabled = false;
    await expect(linearSessionRunInputs(f.session, f.deps)).rejects.toThrow(
      "disabled",
    );
    f.config.enabled = true;
    f.config.id = "replacement";
    await expect(linearSessionRunInputs(f.session, f.deps)).rejects.toThrow(
      "configured",
    );
    f.deps.config = async () => null;
    await expect(linearSessionRunInputs(f.session, f.deps)).rejects.toThrow(
      "configured",
    );
    expect(f.tokenCalls).toEqual([]);
  });

  test("refuses missing apps, organizations, or disconnected grants", async () => {
    const f = fixture();
    f.deps.app = (appId) => ({
      id: appId,
      name: "Acme",
      clientId: "",
      clientSecret: "",
      webhookSecret: "",
    });
    await expect(linearSessionRunInputs(f.session, f.deps)).rejects.toThrow(
      "configured",
    );
    const missingOrg = fixture({ organizationId: undefined });
    await expect(
      linearSessionRunInputs(missingOrg.session, missingOrg.deps),
    ).rejects.toThrow("Reconnect");
    const disconnected = fixture();
    disconnected.deps.token = async () => false;
    await expect(
      linearSessionRunInputs(disconnected.session, disconnected.deps),
    ).rejects.toThrow("Reconnect");
  });

  test("legacy primary sessions without a profile keep their old behavior", async () => {
    const f = fixture({
      appId: undefined,
      automationId: undefined,
      organizationId: undefined,
      executionMode: undefined,
    });
    f.deps.config = async () => null;
    expect(await linearSessionRunInputs(f.session, f.deps)).toEqual({
      mode: "code",
    });
    expect(f.tokenCalls).toEqual([]);
  });

  test("legacy primary sessions adopt an existing primary profile and bound org", async () => {
    const f = fixture({ appId: undefined, automationId: undefined });
    expect(
      (await linearSessionRunInputs(f.session, f.deps))?.linearGrant,
    ).toEqual({ appId: "primary", organizationId: "acme-org" });
  });

  test("explicit primary identity without a profile keeps legacy execution and a scoped grant", async () => {
    const f = fixture({ appId: "primary", automationId: undefined });
    f.deps.config = async () => null;
    const result = await linearSessionRunInputs(f.session, f.deps);
    expect(result?.mode).toBe("ask");
    expect(result?.linearGrant).toEqual({
      appId: "primary",
      organizationId: "acme-org",
    });
    expect(result?.mcpServers).toBeUndefined();
  });

  test("does not inspect non-Linear sessions", async () => {
    const f = fixture();
    expect(
      await linearSessionRunInputs(
        { ...f.session, source: "opensession" },
        f.deps,
      ),
    ).toBeNull();
    expect(f.sourceKeys).toEqual([]);
  });
});
