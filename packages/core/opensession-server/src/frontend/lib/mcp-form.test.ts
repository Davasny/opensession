import { describe, expect, test } from "bun:test";
import {
  parseMcpEnvironment,
  parseMcpEnvironmentUpdates,
  parseMcpHeaderRows,
  parseMcpHeaderUpdates,
  type McpEditRow,
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

describe("parseMcpHeaderUpdates", () => {
  const row = (name: string, value: string, saved?: boolean): McpEditRow => ({
    name,
    value,
    saved,
  });

  test("keeps a saved value when the editor leaves it blank", () => {
    expect(
      parseMcpHeaderUpdates([
        row("Authorization", "", true),
        row("X-API-Key", " new-key "),
        row("X-Trace", " 1 "),
      ]),
    ).toEqual([
      { name: "Authorization", value: null },
      { name: "X-API-Key", value: "new-key" },
      { name: "X-Trace", value: "1" },
    ]);
  });

  test("requires a value on a new row", () => {
    expect(() => parseMcpHeaderUpdates([row("X-API-Key", "")])).toThrow(
      'Header "X-API-Key" needs a value',
    );
  });
});

describe("parseMcpEnvironmentUpdates", () => {
  const row = (name: string, value: string, saved?: boolean): McpEditRow => ({
    name,
    value,
    saved,
  });

  test("keeps saved values and stores a blank new key as an empty value", () => {
    expect(
      parseMcpEnvironmentUpdates([
        row("TOKEN", "", true),
        row("NEW_KEY", ""),
        row("ROTATED", " next "),
      ]),
    ).toEqual([
      { name: "TOKEN", value: null },
      { name: "NEW_KEY", value: "" },
      { name: "ROTATED", value: "next" },
    ]);
  });

  test("rejects blank names and duplicate keys", () => {
    expect(() => parseMcpEnvironmentUpdates([row("", "value")])).toThrow(
      "Env variable name is required",
    );
    expect(() =>
      parseMcpEnvironmentUpdates([row("TOKEN", "a"), row("TOKEN", "b")]),
    ).toThrow('Duplicate env variable "TOKEN"');
  });
});
