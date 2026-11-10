import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getValidToken, refreshAccessToken, refreshToken } from "./oauth";

const originalEnv = {
  HOME: process.env.HOME,
  LINEAR_CLIENT_ID: process.env.LINEAR_CLIENT_ID,
  LINEAR_CLIENT_SECRET: process.env.LINEAR_CLIENT_SECRET,
};
let scratch = "";
let fetchSpy: ReturnType<typeof spyOn<typeof globalThis, "fetch">>;
const fetchPreconnect = globalThis.fetch.preconnect;

function mockFetch(
  implementation: (
    ...args: Parameters<typeof fetch>
  ) => ReturnType<typeof fetch>,
) {
  fetchSpy.mockImplementation(
    Object.assign(implementation, { preconnect: fetchPreconnect }),
  );
}

beforeEach(async () => {
  scratch = await mkdtemp(join(tmpdir(), "linear-refresh-test-"));
  process.env.HOME = scratch;
  process.env.LINEAR_CLIENT_ID = "test-client";
  process.env.LINEAR_CLIENT_SECRET = "test-secret";
  fetchSpy = spyOn(globalThis, "fetch");
});

afterEach(async () => {
  fetchSpy.mockRestore();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  await rm(scratch, { recursive: true, force: true });
});

test("concurrent refreshes share one token exchange", async () => {
  let calls = 0;
  mockFetch(async () => {
    calls++;
    await Bun.sleep(10);
    return Response.json({
      access_token: "fresh-1",
      refresh_token: "refresh-2",
      expires_in: 3600,
    });
  });

  const tokens = {
    "org-1": {
      accessToken: "stale",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
    },
  };

  // Linear rotates the refresh token: a second concurrent exchange would spend
  // the one the first request already replaced.
  const results = await Promise.all([
    refreshToken("org-1", tokens),
    refreshToken("org-1", tokens),
  ]);

  expect(results).toEqual([true, true]);
  expect(calls).toBe(1);
  expect(tokens["org-1"]!.accessToken).toBe("fresh-1");
  expect(tokens["org-1"]!.refreshToken).toBe("refresh-2");
});

test("refreshAccessToken rotates the token bound by getValidToken", async () => {
  mockFetch(async () =>
    Response.json({
      access_token: "fresh-2",
      expires_in: 3600,
    }),
  );

  const tokens = {
    "org-1": {
      accessToken: "stale-2",
      refreshToken: "refresh-1",
      expiresAt: Date.now() + 3_600_000,
    },
  };

  expect(await getValidToken("org-1", tokens)).toBe("stale-2");
  expect(await refreshAccessToken("stale-2")).toBe("fresh-2");
  expect(tokens["org-1"]!.accessToken).toBe("fresh-2");
});

test("a failed exchange leaves the stored grant untouched", async () => {
  mockFetch(async () =>
    Response.json({ error: "invalid_grant" }, { status: 400 }),
  );

  const tokens = {
    "org-1": {
      accessToken: "stale-3",
      refreshToken: "refresh-1",
      expiresAt: Date.now() - 1000,
    },
  };

  expect(await refreshToken("org-1", tokens)).toBe(false);
  expect(tokens["org-1"]!.accessToken).toBe("stale-3");
});
