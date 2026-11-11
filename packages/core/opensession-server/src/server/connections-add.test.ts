import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { addMcpServer, cleanMcpHeaders, loadMcpConfig } from "./connections";

let dir: string;
let configPath: string;
const previous = process.env.OPENSESSION_MCP_CONFIG;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), "os-add-mcp-"));
  configPath = join(dir, "mcp-config.json");
  writeFileSync(configPath, JSON.stringify({ mcpServers: {} }));
  process.env.OPENSESSION_MCP_CONFIG = configPath;
  await loadMcpConfig();
});

afterEach(() => {
  if (previous === undefined) delete process.env.OPENSESSION_MCP_CONFIG;
  else process.env.OPENSESSION_MCP_CONFIG = previous;
  rmSync(dir, { recursive: true, force: true });
});

function servers(): Record<string, Record<string, unknown>> {
  return JSON.parse(readFileSync(configPath, "utf-8")).mcpServers;
}

describe("addMcpServer headers", () => {
  test("stores custom headers on an HTTP server", async () => {
    expect(
      await addMcpServer({
        name: "excalidraw",
        transport: "http",
        url: "https://mcp.example.test/mcp",
        headers: {
          Authorization: "Bearer key",
          "X-API-Key": "secret",
        },
      }),
    ).toEqual({ ok: true });
    expect(servers().excalidraw).toEqual({
      type: "http",
      url: "https://mcp.example.test/mcp",
      headers: {
        Authorization: "Bearer key",
        "X-API-Key": "secret",
      },
    });
  });

  test("trims names and values and omits an empty header set", async () => {
    await addMcpServer({
      name: "trimmed",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      headers: { " Authorization ": " Bearer key " },
    });
    expect(servers().trimmed.headers).toEqual({ Authorization: "Bearer key" });

    await addMcpServer({
      name: "none",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      headers: {},
    });
    expect(servers().none.headers).toBeUndefined();
  });

  test.each([
    [{ "bad header": "value" }, 'Invalid header name "bad header"'],
    [
      { Authorization: "line\nbreak" },
      'Header "Authorization" contains invalid characters',
    ],
    [
      { Authorization: "one", authorization: "two" },
      'Duplicate header "authorization"',
    ],
    [{ Authorization: "  " }, 'Header "Authorization" needs a value'],
  ] as const)("rejects invalid headers %o", async (headers, error) => {
    const result = await addMcpServer({
      name: "rejected",
      transport: "http",
      url: "https://mcp.example.test/mcp",
      headers: { ...headers },
    });
    expect(result).toEqual({ error });
    expect(servers().rejected).toBeUndefined();
  });

  test("rejects headers on a stdio server", async () => {
    const result = await addMcpServer({
      name: "local",
      transport: "stdio",
      command: "my-mcp",
      headers: { Authorization: "Bearer key" },
    });
    expect(result).toEqual({
      error: "Headers are only supported for HTTP servers",
    });
    expect(servers().local).toBeUndefined();
  });
});

describe("cleanMcpHeaders", () => {
  test("rejects non-object and non-string values", () => {
    expect(cleanMcpHeaders([])).toEqual({
      error: "Headers must be an object of name/value pairs",
    });
    expect(cleanMcpHeaders({ Authorization: 1 })).toEqual({
      error: 'Header "Authorization" value must be a string',
    });
  });
});
