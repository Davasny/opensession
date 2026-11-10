import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  configPath,
  getConfig,
  publishConfigSnapshot,
} from "../../server/config";
import { stateDir } from "../../server/paths";
import {
  getLoadedTokens,
  getValidToken,
  handleAuthorize,
  handleCallback,
  linearAppIdFromState,
  loadTokens,
  refreshAccessToken,
  refreshToken,
  saveTokens,
} from "./oauth";

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
const originalConfig = JSON.stringify(getConfig());
const originalEnv = {
  HOME: process.env.HOME,
  LINEAR_CLIENT_ID: process.env.LINEAR_CLIENT_ID,
  LINEAR_CLIENT_SECRET: process.env.LINEAR_CLIENT_SECRET,
  OPENSESSION_STATE_DIR: process.env.OPENSESSION_STATE_DIR,
};
let scratch = "";

function configureApps(includeAdditional = true) {
  publishConfigSnapshot(
    configPath(),
    JSON.stringify({
      integrations: {
        linear: {
          apps: includeAdditional
            ? [
                {
                  id: "acme",
                  name: "Acme",
                  oauthClientId: "acme-client",
                  oauthClientSecret: "acme-secret",
                },
              ]
            : [],
        },
      },
    }),
  );
}

beforeEach(async () => {
  fetchSpy = spyOn(globalThis, "fetch");
  scratch = await mkdtemp(join(tmpdir(), "linear-oauth-test-"));
  process.env.HOME = scratch;
  process.env.OPENSESSION_STATE_DIR = scratch;
  process.env.LINEAR_CLIENT_ID = "primary-client";
  process.env.LINEAR_CLIENT_SECRET = "primary-secret";
  configureApps();
});

afterEach(async () => {
  fetchSpy.mockRestore();
  for (const [key, value] of Object.entries(originalEnv)) {
    if (value === undefined) delete process.env[key];
    else process.env[key] = value;
  }
  publishConfigSnapshot(configPath(), originalConfig);
  await rm(scratch, { recursive: true, force: true });
});

describe("Linear app token isolation", () => {
  test("stores additional app tokens separately and preserves the legacy primary path", async () => {
    const primary = await loadTokens();
    const additional = await loadTokens("acme");
    primary["same-org"] = { accessToken: "primary-token" };
    additional["same-org"] = { accessToken: "additional-token" };
    await saveTokens(primary);
    await saveTokens(additional);

    expect(
      await Bun.file(join(scratch, ".linear-agent-tokens.json")).json(),
    ).toEqual(primary);
    expect(
      await Bun.file(
        join(stateDir("linear-apps"), "acme", "tokens.json"),
      ).json(),
    ).toEqual(additional);
    expect(await loadTokens()).toBe(primary);
    expect(await loadTokens("acme")).toBe(additional);
    expect(getLoadedTokens("acme")).toEqual(additional);
    await expect(loadTokens("unknown")).rejects.toThrow("Unknown Linear app");
  });

  test("deduplicates concurrent loads and shares refreshed tokens with later callers", async () => {
    const filePath = join(stateDir("linear-apps"), "acme", "tokens.json");
    await Bun.write(
      filePath,
      JSON.stringify({
        org: { accessToken: "shared-stale", refreshToken: "shared-refresh" },
      }),
    );
    const [first, second] = await Promise.all([
      loadTokens("acme"),
      loadTokens("acme"),
    ]);
    expect(second).toBe(first);
    expect(getLoadedTokens("acme")).toBe(first);
    mockFetch(async () =>
      Response.json({
        access_token: "shared-fresh",
        refresh_token: "shared-rotated",
      }),
    );

    expect(
      await Promise.all([
        refreshToken("org", first),
        refreshToken("org", second),
      ]),
    ).toEqual([true, true]);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(await getValidToken("org", second)).toBe("shared-fresh");
    expect(await loadTokens("acme")).toBe(first);
    expect((await loadTokens("acme")).org?.accessToken).toBe("shared-fresh");
  });

  test("refreshes the same org independently for each app and searches all loaded collections", async () => {
    const primary = await loadTokens();
    const additional = await loadTokens("acme");
    primary["same-org"] = {
      accessToken: "primary-stale",
      refreshToken: "primary-refresh",
    };
    additional["same-org"] = {
      accessToken: "additional-stale",
      refreshToken: "additional-refresh",
    };
    const requests: URLSearchParams[] = [];
    mockFetch(async (_url, init) => {
      const params = new URLSearchParams(String(init?.body));
      requests.push(params);
      return Response.json({
        access_token: `${params.get("client_id")}-fresh`,
        refresh_token: "rotated",
        expires_in: 3600,
      });
    });

    const results = await Promise.all([
      refreshAccessToken("primary-stale"),
      refreshAccessToken("additional-stale"),
      refreshToken("same-org", additional),
    ]);
    expect(results).toEqual([
      "primary-client-fresh",
      "acme-client-fresh",
      true,
    ]);
    expect(requests).toHaveLength(2);
    expect(
      requests.map((request) => [
        request.get("client_id"),
        request.get("client_secret"),
        request.get("refresh_token"),
      ]),
    ).toEqual([
      ["primary-client", "primary-secret", "primary-refresh"],
      ["acme-client", "acme-secret", "additional-refresh"],
    ]);
    expect(await getValidToken("same-org", additional)).toBe(
      "acme-client-fresh",
    );
    expect(
      (await Bun.file(join(scratch, ".linear-agent-tokens.json")).json())[
        "same-org"
      ].accessToken,
    ).toBe("primary-client-fresh");
  });

  test("does not publish a token collection if its app is removed during loading", async () => {
    const loading = loadTokens("acme");
    configureApps(false);
    await expect(loading).rejects.toThrow(
      "Linear app changed while loading tokens",
    );
    expect(getLoadedTokens("acme")).toBeUndefined();
  });

  test("rejects removed apps and changed app identities without exchanging a grant", async () => {
    const tokens = await loadTokens("acme");
    tokens.org = { accessToken: "removed-token", refreshToken: "refresh" };
    let calls = 0;
    mockFetch(async () => {
      calls++;
      return Response.json({});
    });
    configureApps(false);
    expect(await refreshToken("org", tokens)).toBe(false);
    expect(await refreshAccessToken("removed-token")).toBeNull();
    expect(await getValidToken("org", tokens)).toBeNull();
    expect(getLoadedTokens("acme")).toBeUndefined();
    expect(handleAuthorize("acme").status).toBe(400);
    await expect(saveTokens(tokens)).rejects.toThrow();
    publishConfigSnapshot(
      configPath(),
      JSON.stringify({
        integrations: {
          linear: {
            apps: [
              {
                id: "acme",
                name: "Acme",
                oauthClientId: "replacement-client",
                oauthClientSecret: "replacement-secret",
              },
            ],
          },
        },
      }),
    );
    expect(await refreshToken("org", tokens)).toBe(false);
    const replacement = await loadTokens("acme");
    expect(replacement).not.toBe(tokens);
    expect(getLoadedTokens("acme")).toBe(replacement);
    expect(calls).toBe(0);
  });

  test("binds state cookies and credentials to the authorized app", async () => {
    const primary = handleAuthorize();
    const additional = handleAuthorize("acme");
    const state = stateFromAuthorize(additional);
    const cookie = additional.headers.get("Set-Cookie")!.split(";", 1)[0];
    const redirect = new URL(additional.headers.get("Location")!);
    expect(redirect.searchParams.get("client_id")).toBe("acme-client");
    expect(redirect.searchParams.get("redirect_uri")).toEndWith(
      "/oauth/callback",
    );
    expect(state).toStartWith("acme.");
    expect(linearAppIdFromState(state)).toBe("acme");
    expect(linearAppIdFromState(stateFromAuthorize(primary))).toBe("primary");
    expect(cookie).not.toStartWith("__Host-linear-oauth-state=");
    const tokens = await loadTokens("acme");
    let calls = 0;
    let exchange: URLSearchParams | undefined;
    mockFetch(async (_url, init) => {
      calls++;
      exchange = new URLSearchParams(String(init?.body));
      return Response.json(
        { error: "invalid_grant", error_description: "secret-response" },
        { status: 400 },
      );
    });
    const url = new URL(
      `https://example.test/oauth/callback?code=code&state=${state}`,
    );
    const swapped = await handleCallback(
      new Request(url, {
        headers: {
          Cookie: primary.headers.get("Set-Cookie")!.split(";", 1)[0]!,
        },
      }),
      url,
      tokens,
      "acme",
    );
    expect(swapped.status).toBe(400);
    expect(calls).toBe(0);
    const response = await handleCallback(
      new Request(url, { headers: { Cookie: cookie! } }),
      url,
      tokens,
      "acme",
    );
    expect(response.status).toBe(400);
    expect(exchange?.get("client_id")).toBe("acme-client");
    expect(exchange?.get("client_secret")).toBe("acme-secret");
    expect(exchange?.get("redirect_uri")).toBe(
      redirect.searchParams.get("redirect_uri"),
    );
    expect(response.headers.get("Set-Cookie")).toBe(
      `${cookie!.split("=", 1)[0]}=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0`,
    );
    expect(await response.text()).not.toContain("secret-response");
    expect(handleAuthorize("unknown").status).toBe(400);
    process.env.LINEAR_CLIENT_SECRET = "";
    expect(handleAuthorize().status).toBe(400);
  });

  test("a successful callback saves only its app and refuses another app's collection", async () => {
    const primary = await loadTokens();
    const additional = await loadTokens("acme");
    primary.org = { accessToken: "original-primary-token" };
    await saveTokens(primary);
    const authorize = handleAuthorize("acme");
    const url = new URL(
      `https://example.test/oauth/callback?code=code&state=${stateFromAuthorize(authorize)}`,
    );
    const req = new Request(url, {
      headers: {
        Cookie: authorize.headers.get("Set-Cookie")!.split(";", 1)[0]!,
      },
    });
    let calls = 0;
    mockFetch(async () => {
      calls++;
      return calls === 1
        ? Response.json({
            access_token: "callback-token",
            refresh_token: "callback-refresh",
          })
        : Response.json({
            data: { organization: { id: "org", name: "Example workspace" } },
          });
    });

    expect((await handleCallback(req, url, primary, "acme")).status).toBe(400);
    expect(calls).toBe(0);
    expect((await handleCallback(req, url, additional, "acme")).status).toBe(
      200,
    );
    expect(calls).toBe(2);
    expect(additional.org?.accessToken).toBe("callback-token");
    expect(primary.org.accessToken).toBe("original-primary-token");
    expect(
      (await Bun.file(join(scratch, ".linear-agent-tokens.json")).json()).org
        .accessToken,
    ).toBe("original-primary-token");
    expect(
      (
        await Bun.file(
          join(stateDir("linear-apps"), "acme", "tokens.json"),
        ).json()
      ).org.accessToken,
    ).toBe("callback-token");
  });
});

function stateFromAuthorize(response: Response): string {
  const location = response.headers.get("Location");
  expect(location).not.toBeNull();
  return new URL(location!).searchParams.get("state")!;
}

describe("Linear OAuth state binding", () => {
  test("sets a secure, short-lived state cookie and forwards that state to Linear", () => {
    const response = handleAuthorize();
    const state = stateFromAuthorize(response);

    expect(state).toMatch(/^[A-Za-z0-9_-]{40,}$/);
    expect(response.headers.get("Set-Cookie")).toBe(
      `__Host-linear-oauth-state=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=600`,
    );
  });

  test("uses one callback and carries the additional app in state", () => {
    const primary = new URL(handleAuthorize().headers.get("Location")!);
    const additional = new URL(
      handleAuthorize("acme").headers.get("Location")!,
    );
    const state = additional.searchParams.get("state")!;

    expect(additional.searchParams.get("redirect_uri")).toBe(
      primary.searchParams.get("redirect_uri"),
    );
    expect(linearAppIdFromState(state)).toBe("acme");
    expect(linearAppIdFromState(null)).toBe("primary");
    expect(linearAppIdFromState("not-an-app")).toBe("primary");
    expect(linearAppIdFromState("../bad.nonce")).toBe("primary");
  });

  test("rejects callbacks without the browser-bound state before exchanging a code", async () => {
    let fetches = 0;
    mockFetch(async () => {
      fetches++;
      return Response.json({});
    });

    const response = await handleCallback(
      new Request("https://example.test/oauth/callback"),
      new URL(
        "https://example.test/oauth/callback?code=attacker-code&state=wrong",
      ),
      {},
    );

    expect(response.status).toBe(400);
    expect(fetches).toBe(0);
    expect(response.headers.get("Set-Cookie")).toBe(
      "__Host-linear-oauth-state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
  });

  test("consumes a matching state before reporting an OAuth exchange failure", async () => {
    const authorize = handleAuthorize();
    const state = stateFromAuthorize(authorize);
    const cookie = authorize.headers.get("Set-Cookie")!.split(";", 1)[0];
    let fetches = 0;
    mockFetch(async () => {
      fetches++;
      return Response.json({ error: "invalid_grant" }, { status: 400 });
    });

    const response = await handleCallback(
      new Request("https://example.test/oauth/callback", {
        headers: { Cookie: cookie },
      }),
      new URL(
        `https://example.test/oauth/callback?code=expired-code&state=${state}`,
      ),
      {},
    );

    expect(response.status).toBe(400);
    expect(fetches).toBe(1);
    expect(response.headers.get("Set-Cookie")).toBe(
      "__Host-linear-oauth-state=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0",
    );
  });
});
