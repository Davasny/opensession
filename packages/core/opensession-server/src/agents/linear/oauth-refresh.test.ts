import { afterEach, expect, test } from "bun:test";

const { getValidToken, refreshAccessToken, refreshToken } =
  await import("./oauth");

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

test("concurrent refreshes share one token exchange", async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    await Bun.sleep(10);
    return Response.json({
      access_token: "fresh-1",
      refresh_token: "refresh-2",
      expires_in: 3600,
    });
  }) as unknown as typeof fetch;

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
  globalThis.fetch = (async () =>
    Response.json({
      access_token: "fresh-2",
      expires_in: 3600,
    })) as unknown as typeof fetch;

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
  globalThis.fetch = (async () =>
    Response.json(
      { error: "invalid_grant" },
      { status: 400 },
    )) as unknown as typeof fetch;

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
