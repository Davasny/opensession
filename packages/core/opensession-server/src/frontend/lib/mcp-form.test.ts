import { describe, expect, test } from "bun:test";
import { parseMcpEnvironment, parseMcpHeaders } from "./mcp-form";

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

describe("parseMcpHeaders", () => {
  test("parses header values after the first separator", () => {
    expect(
      parseMcpHeaders("Authorization=Bearer abc123\nX-API-Key=key=with=equals"),
    ).toEqual({
      Authorization: "Bearer abc123",
      "X-API-Key": "key=with=equals",
    });
  });

  test("rejects malformed header lines", () => {
    expect(() => parseMcpHeaders("Authorization")).toThrow(
      'Header line "Authorization" must be NAME=VALUE',
    );
  });
});
