import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConnections, loadMcpConfig, updateMcpServer } from "./connections";

let dir: string;
let configPath: string;
const previous = process.env.OPENSESSION_MCP_CONFIG;
const realFetch = globalThis.fetch;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "os-update-mcp-"));
  configPath = join(dir, "mcp-config.json");
  process.env.OPENSESSION_MCP_CONFIG = configPath;
  await loadMcpConfig();
});

afterEach(() => {
  if (previous === undefined) delete process.env.OPENSESSION_MCP_CONFIG;
  else process.env.OPENSESSION_MCP_CONFIG = previous;
  globalThis.fetch = realFetch;
  rmSync(dir, { recursive: true, force: true });
});

async function seed(servers: Record<string, unknown>): Promise<void> {
  writeFileSync(configPath, JSON.stringify({ mcpServers: servers }));
  await loadMcpConfig();
}

function stored(): Record<string, any> {
  return JSON.parse(readFileSync(configPath, "utf-8")).mcpServers;
}

describe("updateMcpServer", () => {
  test("keeps a stored query string when the replacement URL has none", async () => {
    await seed({
      acme: {
        type: "http",
        url: "https://mcp.example.test/mcp?token=secret",
        headers: { Authorization: "Bearer old", "X-Legacy": "old" },
        oauthUrl: "https://auth.example.test/mcp",
      },
    });

    expect(
      await updateMcpServer("acme", {
        url: "https://mcp.example.test/mcp/v2",
        headers: [
          { name: "Authorization", value: null },
          { name: "X-API-Key", value: "new-key" },
        ],
      }),
    ).toEqual({ ok: true });

    expect(stored().acme).toEqual({
      type: "http",
      url: "https://mcp.example.test/mcp/v2?token=secret",
      headers: { Authorization: "Bearer old", "X-API-Key": "new-key" },
      // A key this form does not own stays put.
      oauthUrl: "https://auth.example.test/mcp",
    });
  });

  test("requires a value on a new header and leaves the config untouched", async () => {
    await seed({
      acme: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer old" },
      },
    });
    const before = stored();

    expect(
      await updateMcpServer("acme", {
        headers: [{ name: "X-API-Key", value: null }],
      }),
    ).toEqual({ error: 'Header "X-API-Key" needs a value' });
    expect(stored()).toEqual(before);
  });

  test("replacing a saved header replaces only that value", async () => {
    await seed({
      acme: {
        type: "http",
        url: "https://mcp.example.test/mcp",
        headers: { Authorization: "Bearer old" },
      },
    });

    await updateMcpServer("acme", {
      headers: [{ name: "Authorization", value: " Bearer new " }],
    });
    expect(stored().acme.headers).toEqual({ Authorization: "Bearer new" });
  });

  test("keeps saved env values, adds a blank new key, and removes omitted keys", async () => {
    await seed({
      local: {
        command: "bun",
        args: ["run", "/old.ts"],
        env: { TOKEN: "old", DROP_ME: "yes" },
        oauthUrl: "https://auth.example.test/mcp",
      },
    });

    expect(
      await updateMcpServer("local", {
        command: "bun",
        args: ["run", "/new.ts"],
        env: [
          { name: "TOKEN", value: null },
          { name: "NEW_KEY", value: "" },
        ],
      }),
    ).toEqual({ ok: true });

    expect(stored().local).toEqual({
      command: "bun",
      args: ["run", "/new.ts"],
      env: { TOKEN: "old", NEW_KEY: "" },
      oauthUrl: "https://auth.example.test/mcp",
    });
  });

  test("refuses a transport change and fields for the other transport", async () => {
    await seed({ acme: { type: "http", url: "https://mcp.example.test/mcp" } });

    expect(
      await updateMcpServer("acme", { transport: "stdio", command: "bun" }),
    ).toEqual({
      error: "Transport can't be changed. Remove the server and add it again.",
    });
    expect(
      await updateMcpServer("acme", { env: [{ name: "A", value: "b" }] }),
    ).toEqual({ error: "Environment is only supported for stdio servers" });
  });

  test("updates and clears the allowlist", async () => {
    await seed({
      ordinary: { command: "ordinary-mcp", allowedUsers: ["admin"] },
      "apple-release": { command: "release-mcp", allowedUsers: ["admin"] },
    });

    expect(
      await updateMcpServer("ordinary", { allowedUsers: ["member"] }),
    ).toEqual({ ok: true, allowedUsers: ["member"] });
    expect(stored().ordinary.allowedUsers).toEqual(["member"]);

    expect(await updateMcpServer("ordinary", { allowedUsers: [] })).toEqual({
      ok: true,
    });
    expect(stored().ordinary.allowedUsers).toBeUndefined();

    expect(
      await updateMcpServer("apple-release", { allowedUsers: [] }),
    ).toEqual({
      error: 'Server "apple-release" requires at least one allowed user',
    });
    expect(stored()["apple-release"].allowedUsers).toEqual(["admin"]);
  });

  test("reports a missing server", async () => {
    expect(await updateMcpServer("absent", { command: "bun" })).toEqual({
      error: 'Server "absent" not found',
      notFound: true,
    });
  });
});

describe("connection edit details", () => {
  test("expose targets without header or env values", async () => {
    globalThis.fetch = (async () =>
      new Response("{}", { status: 200 })) as unknown as typeof fetch;
    await seed({
      acme: {
        type: "http",
        url: "https://mcp.example.test/mcp?token=secret",
        headers: { Authorization: "Bearer old" },
      },
      local: {
        command: "bun",
        args: ["run", "/missing.ts"],
        env: { TOKEN: "secret" },
      },
    });

    const connections = await getConnections(true);
    const acme = connections.find((c) => c.name === "acme")!;
    expect(acme).toMatchObject({
      transport: "http",
      target: "https://mcp.example.test/mcp",
      url: "https://mcp.example.test/mcp",
      urlHasQuery: true,
      headerNames: ["Authorization"],
    });
    expect((acme as any).headers).toBeUndefined();

    const local = connections.find((c) => c.name === "local")!;
    expect(local).toMatchObject({
      transport: "stdio",
      target: "bun run /missing.ts",
      command: "bun",
      args: ["run", "/missing.ts"],
      envKeys: ["TOKEN"],
    });
    expect((local as any).env).toBeUndefined();
  });
});
