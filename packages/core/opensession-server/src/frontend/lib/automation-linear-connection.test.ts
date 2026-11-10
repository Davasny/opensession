import { afterEach, describe, expect, test } from "bun:test";
import {
  fetchAutomationLinearConnections,
  linearConnectionKey,
  linearConnectionLabel,
} from "./automation-linear-connection";

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

const respond = (response: Response) => {
  globalThis.fetch = Object.assign(async () => response, {
    preconnect: originalFetch.preconnect,
  });
};

describe("automation Linear connections", () => {
  test("keeps distinct apps and workspaces separate and strips token fields", async () => {
    respond(
      Response.json({
        connections: [
          {
            appId: "acme",
            appName: "Acme",
            organizationId: "one",
            accessToken: "example-secret",
          },
          { appId: "acme", appName: "Acme", organizationId: "two" },
          {
            appId: "other",
            appName: "Other",
            organizationId: "one",
            organizationName: "Acme workspace",
          },
        ],
      }),
    );
    const connections = await fetchAutomationLinearConnections();
    expect(new Set(connections.map(linearConnectionKey)).size).toBe(3);
    expect(connections[0]).not.toHaveProperty("accessToken");
    expect(linearConnectionLabel(connections[2])).toBe(
      "Other · Acme workspace",
    );
    expect(linearConnectionLabel(connections[0])).toBe("Acme · one");
  });

  test("rejects malformed connection metadata instead of offering an unusable app", async () => {
    respond(
      Response.json({ connections: [{ appId: "acme", appName: "Acme" }] }),
    );
    await expect(fetchAutomationLinearConnections()).rejects.toThrow();
    respond(
      Response.json({
        connections: [{ appId: "", appName: "Acme", organizationId: "one" }],
      }),
    );
    await expect(fetchAutomationLinearConnections()).rejects.toThrow();
  });

  test("distinguishes an empty list from a loading error", async () => {
    respond(Response.json({ connections: [] }));
    expect(await fetchAutomationLinearConnections()).toEqual([]);
    respond(
      Response.json(
        { error: "Connection lookup unavailable" },
        { status: 503 },
      ),
    );
    await expect(fetchAutomationLinearConnections()).rejects.toThrow(
      "Connection lookup unavailable",
    );
  });
});
