import { describe, expect, test } from "bun:test";
import {
  parseMcpEnvironment,
  parseMcpHeaderRows,
  type McpHeaderRow,
} from "./mcp-form";

describe("parseMcpEnvironment", () => {
  test("parses values after the first separator", () => {
    expect(
      parseMcpEnvironment("TOKEN=secret\nURL=https://x.test?a=b\n"),
    ).toEqual({
      TOKEN: "secret",
      URL: "https://x.test?a=b",
    });
  });

  test("ignores blank lines and rejects malformed entries", () => {
    expect(parseMcpEnvironment("\n KEY = value \n")).toEqual({ KEY: "value" });
    expect(() => parseMcpEnvironment("TOKEN")).toThrow(
      'Env line "TOKEN" must be KEY=VALUE',
    );
  });
});

describe("parseMcpHeaderRows", () => {
  const row = (name: string, value: string): McpHeaderRow => ({ name, value });

  test("builds headers from named rows and skips blank rows", () => {
    expect(
      parseMcpHeaderRows([
        row(" Authorization ", " Bearer abc123 "),
        row("", ""),
        row("X-API-Key", "key=with=equals"),
      ]),
    ).toEqual({
      Authorization: "Bearer abc123",
      "X-API-Key": "key=with=equals",
    });
  });

  test("rejects partial and duplicate rows", () => {
    expect(() => parseMcpHeaderRows([row("Authorization", "")])).toThrow(
      'Header "Authorization" needs a value',
    );
    expect(() => parseMcpHeaderRows([row("", "Bearer abc123")])).toThrow(
      "Header name is required",
    );
    expect(() =>
      parseMcpHeaderRows([
        row("Authorization", "Bearer one"),
        row("authorization", "Bearer two"),
      ]),
    ).toThrow('Duplicate header "authorization"');
  });
});
