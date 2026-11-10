import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("automation Linear connection CRUD, options, root resume and disconnected grants", async () => {
  const dir = await mkdtemp(join(tmpdir(), "automation-linear-"));
  try {
    const config = join(dir, "config.json");
    await Bun.write(
      config,
      JSON.stringify({
        paths: { mcpConfig: join(dir, "mcp.json") },
        repos: { acme: { repo: dir, default: true } },
        integrations: {
          linear: {
            apps: [
              {
                id: "acme",
                name: "Acme",
                oauthClientId: "acme-client",
                oauthClientSecret: "example-secret",
              },
            ],
          },
        },
      }),
    );
    const source = `
      import { expect } from "bun:test";
      import { getConfigAsync } from ${JSON.stringify(join(import.meta.dir, "config.ts"))};
      import { stateDir } from ${JSON.stringify(join(import.meta.dir, "paths.ts"))};
      import { createAutomation, deleteAutomation, getAutomation, runAutomation, updateAutomation } from ${JSON.stringify(join(import.meta.dir, "automations.ts"))};
      import { automationLinearGrant, listAutomationLinearConnections } from ${JSON.stringify(join(import.meta.dir, "automation-linear-connection.ts"))};
      import { resolveSessionRunInputs } from ${JSON.stringify(join(import.meta.dir, "session-run-inputs.ts"))};
      import { handleAutomationsRoutes } from ${JSON.stringify(join(import.meta.dir, "routes/automations.ts"))};
      import { loadTokens, saveTokens } from ${JSON.stringify(join(import.meta.dir, "../agents/linear/oauth.ts"))};
      await getConfigAsync();
      await Bun.write(stateDir("linear-apps") + "/acme/tokens.json", JSON.stringify({
        org: { accessToken: "example-token", refreshToken: "example-refresh", expiresAt: Date.now() + 3600000 },
        expired: { accessToken: "expired-token", expiresAt: 1 },
      }));
      const grant = { appId: "acme", organizationId: "org" };
      const base = { name: "Acme automation", prompt: "Read issues", schedule: "", mode: "ask", createdBy: "acme" };
      const options = [{ ...grant, appName: "Acme" }];
      expect(await listAutomationLinearConnections()).toEqual(options);
      const path = "/api/automations/linear-connections";
      const response = await handleAutomationsRoutes({ path, req: new Request("https://example.test" + path), url: new URL("https://example.test" + path) });
      expect(await response.json()).toEqual({ connections: options });
      for (const bad of ["acme", [], {}, { appId: "acme" }, { ...grant, accessToken: "injected" }, { ...grant, organizationId: "missing" }, { ...grant, appId: "missing" }, { ...grant, organizationId: "expired" }]) {
        expect(await createAutomation({ ...base, linearConnection: bad })).toHaveProperty("error");
      }
      const created = await createAutomation({ ...base, linearConnection: grant });
      expect(created).not.toHaveProperty("error");
      expect(created.mcpServers).toEqual(["linear"]);
      expect((await getAutomation(created.id)).linearConnection).toEqual(grant);
      expect(await updateAutomation(created.id, { linearConnection: { ...grant, organizationId: "missing" } })).toHaveProperty("error");
      expect((await getAutomation(created.id)).linearConnection).toEqual(grant);
      expect((await updateAutomation(created.id, { mcpServers: ["acme"] })).mcpServers).toEqual(["acme", "linear"]);
      const session = { automation: "Old automation name", automationId: created.id };
      const resumed = await resolveSessionRunInputs(session, { user: "acme" });
      expect(resumed.linearGrant).toEqual(grant);
      expect(resumed.mcpServers).toEqual(["acme", "linear"]);
      expect(resumed.user).toBeUndefined();
      expect((await resolveSessionRunInputs({ ...session, automationDescendantPolicy: { mcpServers: ["linear"] } })).linearGrant).toBeUndefined();
      expect((await resolveSessionRunInputs({ mcpServers: ["linear"] })).linearGrant).toBeUndefined();
      const tokens = await loadTokens("acme");
      delete tokens.org;
      await saveTokens(tokens);
      await expect(automationLinearGrant(grant)).rejects.toThrow("unavailable");
      await expect(automationLinearGrant((await resolveSessionRunInputs(session)).linearGrant)).rejects.toThrow("unavailable");
      const requests = [];
      globalThis.fetch = async (url) => { requests.push(String(url)); throw new Error("Unexpected external request"); };
      await runAutomation({ ...(await getAutomation(created.id)), mode: "scratch" });
      const failed = await getAutomation(created.id);
      expect(failed.lastRunStatus).toBe("error");
      expect(failed.lastRunError).toContain("unavailable");
      expect(failed.runs.at(-1).status).toBe("error");
      expect(requests).toEqual([]);
      expect((await updateAutomation(created.id, { linearConnection: null })).linearConnection).toBeUndefined();
      expect((await resolveSessionRunInputs(session)).linearGrant).toBeUndefined();
      tokens.org = { accessToken: "reconnected-token" };
      await saveTokens(tokens);
      expect((await updateAutomation(created.id, { linearConnection: grant, mcpServers: [] })).mcpServers).toEqual(["linear"]);
      expect((await updateAutomation(created.id, { prompt: "Read recent issues" })).linearConnection).toEqual(grant);
      await Bun.write(${JSON.stringify(join(dir, "mcp.json"))}, JSON.stringify({ mcpServers: {
        "linear-private": { type: "http", url: "https://mcp.linear.app/mcp", allowedUsers: ["acme"] },
      } }));
      await runAutomation({ ...(await getAutomation(created.id)), mode: "scratch" });
      const denied = await getAutomation(created.id);
      expect(denied.lastRunStatus).toBe("error");
      expect(denied.lastRunError).toContain("unavailable for this run");
      expect(denied.runs.at(-1).status).toBe("error");
      expect(requests).toEqual([]);
      await deleteAutomation(created.id);
      const replacement = await createAutomation({ ...base, mcpServers: ["linear"] });
      expect(replacement).not.toHaveProperty("error");
      await expect(resolveSessionRunInputs({ ...session, automation: base.name })).rejects.toThrow("no longer available");
      await expect(resolveSessionRunInputs({ automationId: created.id })).rejects.toThrow("no longer available");
      expect((await resolveSessionRunInputs({ automation: base.name })).mcpServers).toEqual(["linear"]);
      process.exit(0);
    `;
    const proc = Bun.spawn([process.execPath, "-e", source], {
      env: {
        ...process.env,
        HOME: dir,
        OPENSESSION_STATE_DIR: dir,
        OPENSESSION_CONFIG: config,
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stderr, stdout] = await Promise.all([
      proc.exited,
      new Response(proc.stderr).text(),
      new Response(proc.stdout).text(),
    ]);
    expect({
      code,
      stderr: code ? stderr : "",
      stdout: code ? stdout : "",
    }).toEqual({ code: 0, stderr: "", stdout: "" });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}, 30000);
