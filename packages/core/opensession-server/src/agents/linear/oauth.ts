/**
 * Linear OAuth flow and token management.
 */
import { connectResultPage } from "../../server/connect-result-page";
import { fetchWithTimeout } from "../../server/shared/fetch-with-timeout";
import { writeJsonAtomicAsync } from "../../server/shared/atomic-write";
import { randomBytes, timingSafeEqual } from "crypto";
import { personaName } from "../../server/config";
import {
  linearAppById,
  linearAuthorizePath,
  linearRedirectUri,
  validAdditionalLinearAppId,
} from "../../server/linear-app-registry";
import { stateDir } from "../../server/paths";
import { join } from "path";

const STATE_COOKIE = "__Host-linear-oauth-state";
const STATE_TTL_SECONDS = 10 * 60;

function tokensFile(appId: string): string {
  return appId === "primary"
    ? `${process.env.HOME}/.linear-agent-tokens.json`
    : join(stateDir("linear-apps"), appId, "tokens.json");
}

function configuredApp(appId: string) {
  const app = linearAppById(appId);
  return app?.clientId && app.clientSecret ? app : undefined;
}

export interface LinearTokens {
  [orgId: string]: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
  };
}

function isLinearTokens(value: unknown): value is LinearTokens {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    Object.values(value).every(
      (token: unknown) =>
        token !== null &&
        typeof token === "object" &&
        !Array.isArray(token) &&
        "accessToken" in token &&
        typeof token.accessToken === "string" &&
        (!("refreshToken" in token) ||
          token.refreshToken === undefined ||
          typeof token.refreshToken === "string") &&
        (!("expiresAt" in token) ||
          token.expiresAt === undefined ||
          (typeof token.expiresAt === "number" &&
            Number.isFinite(token.expiresAt))),
    )
  );
}

const tokenApps = new WeakMap<
  LinearTokens,
  { appId: string; clientId: string; filePath: string }
>();
const loadedTokens = new Map<string, LinearTokens>();
const tokenCollections = new Set<LinearTokens>();
const tokenLoads = new Map<
  string,
  {
    clientId: string;
    filePath: string;
    promise: Promise<LinearTokens>;
  }
>();

function bindTokens(tokens: LinearTokens, appId = "primary"): LinearTokens {
  const existing = tokenApps.get(tokens);
  if (existing && existing.appId !== appId) {
    throw new Error("Linear token collection belongs to another app");
  }
  if (!existing) {
    const app = linearAppById(appId);
    if (!app) throw new Error("Unknown Linear app");
    tokenApps.set(tokens, {
      appId,
      clientId: app.clientId,
      filePath: tokensFile(appId),
    });
  }
  tokenCollections.add(tokens);
  return tokens;
}

function tokenApp(tokens: LinearTokens) {
  if (!tokenApps.has(tokens)) bindTokens(tokens);
  const binding = tokenApps.get(tokens);
  if (!binding) return undefined;
  const app = configuredApp(binding.appId);
  return app?.clientId === binding.clientId &&
    tokensFile(binding.appId) === binding.filePath
    ? app
    : undefined;
}

export function getLoadedTokens(appId = "primary"): LinearTokens | undefined {
  const tokens = loadedTokens.get(appId);
  return tokens && tokenApp(tokens) ? tokens : undefined;
}

/** One refresh per app and org at a time: Linear rotates refresh tokens, so a second
 *  concurrent exchange would spend the token the first one already replaced. */
const refreshInFlight = new Map<string, Promise<boolean>>();

export async function loadTokens(appId = "primary"): Promise<LinearTokens> {
  const app = linearAppById(appId);
  if (!app) throw new Error("Unknown Linear app");
  const filePath = tokensFile(appId);
  const cached = loadedTokens.get(appId);
  const binding = cached && tokenApps.get(cached);
  if (
    cached &&
    binding?.clientId === app.clientId &&
    binding.filePath === filePath
  ) {
    return cached;
  }
  const loading = tokenLoads.get(appId);
  if (loading?.clientId === app.clientId && loading.filePath === filePath) {
    return loading.promise;
  }
  const promise = (async () => {
    let tokens: LinearTokens = {};
    try {
      const file = Bun.file(filePath);
      if (await file.exists()) {
        const parsed: unknown = JSON.parse(await file.text());
        if (isLinearTokens(parsed)) tokens = parsed;
      }
    } catch {}
    if (
      linearAppById(appId)?.clientId !== app.clientId ||
      tokensFile(appId) !== filePath
    ) {
      throw new Error("Linear app changed while loading tokens");
    }
    const result = bindTokens(tokens, appId);
    loadedTokens.set(appId, result);
    return result;
  })().finally(() => {
    if (tokenLoads.get(appId)?.promise === promise) tokenLoads.delete(appId);
  });
  tokenLoads.set(appId, { clientId: app.clientId, filePath, promise });
  return promise;
}

export async function saveTokens(tokens: LinearTokens): Promise<void> {
  const app = tokenApp(tokens);
  if (!app) throw new Error("Linear app is not configured");
  await writeJsonAtomicAsync(tokensFile(app.id), tokens, true, 0o600);
}

export function refreshToken(
  orgId: string,
  tokens: LinearTokens,
): Promise<boolean> {
  const app = tokenApp(tokens);
  if (!app) return Promise.resolve(false);
  const key = JSON.stringify([app.id, app.clientId, tokensFile(app.id), orgId]);
  const inFlight = refreshInFlight.get(key);
  if (inFlight) return inFlight;
  const run = refreshTokenOnce(orgId, tokens).finally(() => {
    if (refreshInFlight.get(key) === run) refreshInFlight.delete(key);
  });
  refreshInFlight.set(key, run);
  return run;
}

/**
 * Refresh the grant behind an access token that Linear just rejected. Used by
 * the GraphQL helper after a 401 so a revoked token recovers without waiting
 * for its recorded expiry. Returns the new access token, or null when the
 * token is unknown or the exchange failed.
 */
export async function refreshAccessToken(
  accessToken: string,
): Promise<string | null> {
  for (const tokens of tokenCollections) {
    if (!tokenApp(tokens)) continue;
    const orgId = Object.keys(tokens).find(
      (id) => tokens[id]?.accessToken === accessToken,
    );
    if (!orgId) continue;
    if (!(await refreshToken(orgId, tokens))) return null;
    const next = tokens[orgId]?.accessToken;
    return next && next !== accessToken ? next : null;
  }
  return null;
}

async function refreshTokenOnce(
  orgId: string,
  tokens: LinearTokens,
): Promise<boolean> {
  const app = tokenApp(tokens);
  if (!app) return false;
  const tokenData = tokens[orgId];
  if (!tokenData?.refreshToken) {
    console.error(`[linear] No refresh token for org: ${orgId}`);
    return false;
  }

  try {
    const response = await fetchWithTimeout(
      "https://api.linear.app/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          refresh_token: tokenData.refreshToken,
          grant_type: "refresh_token",
        }),
      },
    );

    const data = await response.json();
    if (
      response.ok &&
      data.access_token &&
      tokenApp(tokens)?.clientId === app.clientId
    ) {
      tokens[orgId] = {
        accessToken: data.access_token,
        refreshToken: data.refresh_token || tokenData.refreshToken,
        expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
      };
      await saveTokens(tokens);
      return true;
    } else {
      console.error("[linear] Token refresh failed");
      return false;
    }
  } catch {
    console.error("[linear] Token refresh failed");
    return false;
  }
}

export async function getValidToken(
  orgId: string,
  tokens: LinearTokens,
): Promise<string | null> {
  if (!tokenApp(tokens)) return null;
  const tokenData = tokens[orgId];
  if (!tokenData) return null;

  const isExpired =
    tokenData.expiresAt && tokenData.expiresAt < Date.now() + 5 * 60 * 1000;
  if (isExpired) {
    const refreshed = await refreshToken(orgId, tokens);
    if (!refreshed) return null;
  }

  return tokens[orgId]?.accessToken || null;
}

function cookieValue(req: Request, name: string): string | null {
  const cookie = req.headers.get("cookie");
  if (!cookie) return null;
  for (const part of cookie.split(";")) {
    const [key, ...value] = part.trim().split("=");
    if (key === name && value.length) return value.join("=");
  }
  return null;
}

function stateCookieName(appId: string): string {
  return appId === "primary"
    ? STATE_COOKIE
    : `${STATE_COOKIE}-${Buffer.from(appId).toString("hex")}`;
}

function stateCookie(state: string, maxAge: number, appId: string): string {
  return `${stateCookieName(appId)}=${state}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${maxAge}`;
}

function statesMatch(actual: string | null, expected: string | null): boolean {
  if (!actual || !expected) return false;
  const actualBytes = Buffer.from(actual);
  const expectedBytes = Buffer.from(expected);
  return (
    actualBytes.length === expectedBytes.length &&
    timingSafeEqual(actualBytes, expectedBytes)
  );
}

function consumeState(response: Response, appId = "primary"): Response {
  response.headers.append("Set-Cookie", stateCookie("", 0, appId));
  return response;
}

/** Additional apps prefix the random state with their app id so the shared
 *  callback can select the credentials that started the authorization. */
export function linearAppIdFromState(state: string | null): string {
  if (!state) return "primary";
  const separator = state.indexOf(".");
  if (separator < 0) return "primary";
  const appId = state.slice(0, separator);
  return validAdditionalLinearAppId(appId) ? appId : "primary";
}

export function handleAuthorize(appId = "primary"): Response {
  const app = configuredApp(appId);
  if (!app) return failed("This Linear app is not configured.", appId);
  const nonce = randomBytes(32).toString("base64url");
  const state = appId === "primary" ? nonce : `${appId}.${nonce}`;
  const params = new URLSearchParams({
    client_id: app.clientId,
    redirect_uri: linearRedirectUri(),
    response_type: "code",
    scope: "app:assignable read write",
    actor: "app",
    state,
  });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `https://linear.app/oauth/authorize?${params}`,
      "Set-Cookie": stateCookie(state, STATE_TTL_SECONDS, appId),
    },
  });
}

// Every exit here lands in a person's browser, so they all render the shared
// connect-result card rather than raw text (and never Linear's own JSON, which
// is a token response).
function failed(message: string, appId = "primary"): Response {
  return connectResultPage({
    ok: false,
    server: "linear",
    title: "Linear not authorized",
    message,
    action: { href: linearAuthorizePath(appId), label: "Try again" },
    status: 400,
  });
}

export async function handleCallback(
  req: Request,
  url: URL,
  tokens: LinearTokens,
  appId = "primary",
  redirectUri = linearRedirectUri(),
): Promise<Response> {
  const consume = (response: Response) => consumeState(response, appId);
  const fail = (message: string) => consume(failed(message, appId));
  const app = configuredApp(appId);
  if (!app) return fail("This Linear app is not configured.");
  const binding = tokenApps.get(tokens);
  if (binding && (binding.appId !== appId || !tokenApp(tokens))) {
    return fail("This token collection belongs to another Linear app.");
  }
  bindTokens(tokens, appId);
  const code = url.searchParams.get("code");
  const state = url.searchParams.get("state");
  const expectedState = cookieValue(req, stateCookieName(appId));
  if (!statesMatch(state, expectedState)) {
    return fail("The authorization could not be verified. Start again.");
  }
  if (!code) {
    return fail(
      "The redirect came back without a code, so nothing was authorized.",
    );
  }

  try {
    const response = await fetchWithTimeout(
      "https://api.linear.app/oauth/token",
      {
        method: "POST",
        headers: { "Content-Type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: app.clientId,
          client_secret: app.clientSecret,
          code,
          redirect_uri: redirectUri,
          grant_type: "authorization_code",
        }),
      },
    );

    const data = await response.json();
    if (response.ok && data.access_token) {
      const orgResponse = await fetchWithTimeout(
        "https://api.linear.app/graphql",
        {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: `Bearer ${data.access_token}`,
          },
          body: JSON.stringify({ query: "{ organization { id name } }" }),
        },
      );
      const orgData = await orgResponse.json();
      const orgId = orgData.data?.organization?.id;
      const orgName = orgData.data?.organization?.name;

      if (
        orgResponse.ok &&
        orgId &&
        tokenApp(tokens)?.clientId === app.clientId
      ) {
        tokens[orgId] = {
          accessToken: data.access_token,
          refreshToken: data.refresh_token,
          expiresAt: Date.now() + (data.expires_in || 3600) * 1000,
        };
        await saveTokens(tokens);
        return consume(
          connectResultPage({
            ok: true,
            server: "linear",
            title: "Linear authorized",
            message: `${personaName()} can pick up tickets in ${orgName} now.`,
            action: { close: true },
          }),
        );
      }
      return fail(
        "Linear authorized, but did not say which workspace. Try again.",
      );
    }

    return fail("Linear did not return an access token. Try again.");
  } catch {
    return fail("Linear authorization failed. Try again.");
  }
}
