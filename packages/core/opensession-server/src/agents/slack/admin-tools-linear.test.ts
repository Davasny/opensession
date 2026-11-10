import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const serverDir = join(import.meta.dir, "../../server");

test("admin tools discover Linear connections and bind them to automations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "admin-linear-"));
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
                name: "Dependency agent",
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
      import { Client } from "@modelcontextprotocol/sdk/client/index.js";
      import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
      import { getConfigAsync } from ${JSON.stringify(join(serverDir, "config.ts"))};
      import { stateDir } from ${JSON.stringify(join(serverDir, "paths.ts"))};
      import { getAutomation, listAutomations } from ${JSON.stringify(join(serverDir, "automations.ts"))};
      import { loadTokens } from ${JSON.stringify(join(serverDir, "../agents/linear/oauth.ts"))};
      import { createAdminMcpServer } from ${JSON.stringify(join(import.meta.dir, "admin-tools.ts"))};
      await getConfigAsync();
      await Bun.write(stateDir("linear-apps") + "/acme/tokens.json", JSON.stringify({
        org: { accessToken: "example-token", refreshToken: "example-refresh", expiresAt: Date.now() + 3600000 },
      }));

      const connect = async (isAdmin) => {
        const server = createAdminMcpServer({
          channel: "opensession",
          userId: "acme",
          isDM: false,
          isPrivate: false,
          createdBy: "acme",
          isAdmin,
          actingUser: "acme",
        });
        const client = new Client({ name: "admin-linear-test", version: "1.0.0" });
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.instance.connect(serverTransport);
        await client.connect(clientTransport);
        return { client, server };
      };
      const textOf = (result) => result.content.map((part) => part.text ?? "").join("\\n");

      const admin = await connect(true);
      const tools = (await admin.client.listTools()).tools;
      const names = tools.map((tool) => tool.name);
      expect(names).toEqual(expect.arrayContaining(["list_linear_connections", "create_automation", "update_automation"]));
      for (const name of ["create_automation", "update_automation"]) {
        expect(tools.find((tool) => tool.name === name)?.inputSchema.properties).toHaveProperty("linearConnection");
      }
      const listed = textOf(await admin.client.callTool({ name: "list_linear_connections", arguments: {} }));
      expect(listed).toContain("Dependency agent");
      expect(listed).toContain("acme");
      expect(listed).toContain("org");
      expect(listed).not.toContain("example-token");

      const created = textOf(await admin.client.callTool({
        name: "create_automation",
        arguments: {
          name: "Linear dependency task",
          prompt: "File a dependency update issue.",
          linearConnection: { appId: "acme", organizationId: "org" },
        },
      }));
      expect(created).toContain("Created automation");
      expect(created).toContain("Linear connection acme/org");
      let automation = (await listAutomations()).find((item) => item.name === "Linear dependency task");
      expect(automation).toBeTruthy();
      const id = automation.id;
      expect(automation.mcpServers).toEqual(["linear"]);
      expect(automation.linearConnection).toEqual({ appId: "acme", organizationId: "org" });

      const rejected = textOf(await admin.client.callTool({
        name: "create_automation",
        arguments: {
          name: "Missing workspace",
          prompt: "This must not save.",
          linearConnection: { appId: "acme", organizationId: "missing" },
        },
      }));
      expect(rejected).toContain("unavailable");

      const cleared = textOf(await admin.client.callTool({
        name: "update_automation",
        arguments: { id, linearConnection: null },
      }));
      expect(cleared).toContain("Linear connection cleared");
      automation = await getAutomation(id);
      expect(automation.linearConnection).toBeUndefined();

      const tokens = await loadTokens("acme");
      delete tokens.org;
      const disconnected = textOf(await admin.client.callTool({ name: "list_linear_connections", arguments: {} }));
      expect(disconnected).toContain("configured (Dependency agent)");
      expect(disconnected).toContain("no workspace is connected");

      const limited = await connect(false);
      const limitedNames = (await limited.client.listTools()).tools.map((tool) => tool.name);
      expect(limitedNames).not.toContain("list_linear_connections");
      expect(limitedNames).not.toContain("create_automation");

      await admin.client.close();
      await admin.server.instance.close();
      await limited.client.close();
      await limited.server.instance.close();
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
