import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { isOfficialLinearMcpUrl } from "./connections";

describe("run-bound Linear MCP", () => {
  test("accepts only the official HTTPS host without credentials or custom ports", () => {
    expect(isOfficialLinearMcpUrl("https://mcp.linear.app/mcp")).toBe(true);
    for (const url of [
      "http://mcp.linear.app/mcp",
      "https://mcp.linear.app.example.test/mcp",
      "https://example.test/mcp.linear.app",
      "https://mcp.linear.app@evil.example.test/mcp",
      "https://user@mcp.linear.app/mcp",
      "https://mcp.linear.app:444/mcp",
      "not a URL",
    ])
      expect(isOfficialLinearMcpUrl(url)).toBe(false);
  });

  test("isolates app/org grants, overrides personal headers and fails closed", async () => {
    const dir = await mkdtemp(join(tmpdir(), "linear-mcp-grant-"));
    try {
      const config = join(dir, "config.json");
      const mcpConfig = join(dir, "mcp.json");
      await Bun.write(
        config,
        JSON.stringify({
          paths: { mcpConfig },
          integrations: {
            linear: {
              apps: [
                {
                  id: "acme",
                  name: "Acme",
                  oauthClientId: "acme-client",
                  oauthClientSecret: "example-secret",
                },
                {
                  id: "other",
                  name: "Other",
                  oauthClientId: "other-client",
                  oauthClientSecret: "example-secret",
                },
              ],
            },
          },
        }),
      );
      await Bun.write(
        mcpConfig,
        JSON.stringify({
          mcpServers: {
            linear: {
              type: "http",
              url: "https://mcp.linear.app/mcp",
              allowedUsers: ["alice"],
            },
            "linear-writer": {
              type: "http",
              url: "https://mcp.linear.app/mcp",
              headers: { Authorization: "Bearer unrelated-personal-token" },
              allowedUsers: ["alice"],
            },
          },
        }),
      );
      await Bun.write(
        join(dir, ".opensession-mcp-oauth.json"),
        JSON.stringify({
          linear: {
            serverUrl: "https://mcp.linear.app/mcp",
            endpoints: { authorize: "", token: "" },
            clientInfo: { clientId: "example" },
            shared: {
              tokens: { accessToken: "shared-token" },
              updatedAt: new Date().toISOString(),
            },
          },
        }),
      );
      const source = `
        import { expect } from "bun:test";
        import { getConfigAsync } from ${JSON.stringify(join(import.meta.dir, "config.ts"))};
        import { stateDir } from ${JSON.stringify(join(import.meta.dir, "paths.ts"))};
        import { loadMcpConfig, withLinearRunGrant } from ${JSON.stringify(join(import.meta.dir, "connections.ts"))};
        import { filterMcpServers } from ${JSON.stringify(join(import.meta.dir, "runner-shared.ts"))};
        import { loadMcpOauthStore, mcpSharedGrantHeader } from ${JSON.stringify(join(import.meta.dir, "mcp-oauth.ts"))};
        import { createMcpRuntime } from ${JSON.stringify(join(import.meta.dir, "mcp-runtime.ts"))};
        import { getLoadedTokens, loadTokens } from ${JSON.stringify(join(import.meta.dir, "../agents/linear/oauth.ts"))};
        await getConfigAsync();
        await loadMcpConfig();
        for (const app of ["acme", "other"]) {
          await Bun.write(stateDir("linear-apps") + "/" + app + "/tokens.json", JSON.stringify({
            org: { accessToken: app + "-token", expiresAt: Date.now() + 3600000 },
            second: { accessToken: app + "-second-token", expiresAt: Date.now() + 3600000 },
            expired: { accessToken: "expired", expiresAt: 1 },
          }));
        }
        const cfg = { type: "http", url: "https://mcp.linear.app/mcp", headers: {
          authorization: "Bearer personal", Authorization: "Bearer primary", "x-example": "kept",
        } };
        const sharedTokens = await loadTokens("acme");
        const results = await Promise.all(["acme", "other"].map(appId => withLinearRunGrant(cfg, { appId, organizationId: "org" })));
        expect(getLoadedTokens("acme")).toBe(sharedTokens);
        expect(results.map(result => new Headers(result.headers).get("authorization"))).toEqual(["Bearer acme-token", "Bearer other-token"]);
        expect(new Headers(results[0].headers).get("x-example")).toBe("kept");
        expect(cfg.headers.authorization).toBe("Bearer personal");
        const second = await withLinearRunGrant(cfg, { appId: "acme", organizationId: "second" });
        expect(new Headers(second.headers).get("authorization")).toBe("Bearer acme-second-token");
        for (const grant of [
          { appId: "missing", organizationId: "org" },
          { appId: "acme", organizationId: "missing" },
          { appId: "acme", organizationId: "expired" },
          { appId: "acme", organizationId: "" },
        ]) await expect(withLinearRunGrant(cfg, grant)).rejects.toThrow("unavailable");
        await expect(withLinearRunGrant({ ...cfg, url: "https://example.test/mcp" }, { appId: "acme", organizationId: "org" })).rejects.toThrow("official");
        expect(filterMcpServers([], "alice")).toEqual({});
        expect(filterMcpServers(["linear"], "bob")).toEqual({});
        expect(filterMcpServers(["linear"], "alice")).toHaveProperty("linear");
        await loadMcpOauthStore();
        expect(mcpSharedGrantHeader("linear")).toBe("Bearer shared-token");
        const requests = [];
        globalThis.fetch = async (url, init) => {
          requests.push({ url: String(url), authorization: new Headers(init?.headers).get("authorization") });
          return new Response("unavailable", { status: 503 });
        };
        const bound = await createMcpRuntime({ mcpServers: ["linear"], user: "alice", deniedToolIds: new Set(), linearGrant: { appId: "acme", organizationId: "org" } });
        await bound.catalog();
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every(request => request.url.startsWith("https://mcp.linear.app/") && request.authorization === "Bearer acme-token")).toBe(true);
        await bound.close();
        requests.length = 0;
        const alias = await createMcpRuntime({ mcpServers: ["linear-writer"], user: "alice", deniedToolIds: new Set(), linearGrant: { appId: "acme", organizationId: "org" } });
        await alias.catalog();
        expect(requests.length).toBeGreaterThan(0);
        expect(requests.every(request => request.authorization === "Bearer acme-token")).toBe(true);
        await alias.close();
        requests.length = 0;
        const missing = await createMcpRuntime({ mcpServers: ["linear"], user: "alice", deniedToolIds: new Set(), linearGrant: { appId: "acme", organizationId: "missing" } });
        await missing.catalog();
        expect(requests).toEqual([]);
        await expect(missing.callExact("linear_example", {}, { toolCallId: "example" })).rejects.toThrow("unavailable");
        await missing.close();
        for (const options of [{ mcpServers: [] }, { mcpServers: ["linear"], user: "bob" }]) {
          const restricted = await createMcpRuntime({ ...options, deniedToolIds: new Set(), linearGrant: { appId: "acme", organizationId: "org" } });
          expect(await restricted.catalog()).toEqual([]);
          await restricted.close();
        }
        expect(requests).toEqual([]);
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
      const [code, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stderr).text(),
      ]);
      expect(stderr).not.toContain("expect(received)");
      expect(code).toBe(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
