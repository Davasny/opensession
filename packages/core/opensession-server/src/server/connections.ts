/**
 * Connection status + management for the MCP servers agent sessions
 * run with (mcp-config.json). Targets are sanitized — never expose URL
 * query strings (they can embed tokens) or env/header values.
 */
import { homeDir } from "./paths";
import { unwatchFile, watchFile } from "fs";
import { copyFile, readFile, stat } from "fs/promises";
import { writeFileAtomicAsync } from "./shared/atomic-write";
import {
  cachedJsonFileShared,
  loadJsonFileShared,
} from "./shared/json-file-cache";
import { configuredPaths } from "./config";
import {
  getLoadedTokens,
  getValidToken,
  loadTokens,
} from "../agents/linear/oauth";
import { linearAppById } from "./linear-app-registry";
import { resolveTeammate } from "./shared/user-mappings";
import {
  isOauthCapable,
  mcpOauthStatus,
  mcpSharedGrantHeader,
  mcpUserGrantHeader,
  mcpUserGrantToken,
  oauthPresetFor,
  supportsManualToken,
} from "./mcp-oauth";

const HOME = homeDir();

// Cache the parsed MCP config with file-watcher invalidation. Resolve the path
// per access so a live config reload cannot retain the watcher or cached value
// for a previously configured path.
let cachedMcpConfig: { mcpServers: Record<string, any> } | null = null;
let cachedMcpConfigPath: string | null = null;
let watchedMcpConfigPath: string | null = null;

function setupCacheWatcher(configPath: string) {
  if (watchedMcpConfigPath === configPath) return;
  if (watchedMcpConfigPath) unwatchFile(watchedMcpConfigPath);
  watchedMcpConfigPath = configPath;
  try {
    watchFile(configPath, () => {
      console.log("[mcp-cache] config changed, reloading");
      void loadMcpConfig(configPath);
    });
  } catch (e) {
    watchedMcpConfigPath = null;
    console.warn("[mcp-cache] failed to set up file watcher:", e);
  }
}

// Bumped by every local write, so a disk read that started before the write
// cannot replace the newer in-memory config when it lands.
let mcpConfigRevision = 0;
// Writes run one at a time in call order, so the last one to land carries the
// latest config.
let mcpConfigWrite: Promise<unknown> = Promise.resolve();

/**
 * Read mcp-config.json into the cache readMcpConfig serves. Runs at import
 * and whenever the file watcher sees a change; a test that repoints or
 * rewrites the file awaits it before reading.
 */
export async function loadMcpConfig(
  configPath = configuredPaths().mcpConfig,
): Promise<void> {
  // A local write in flight is newer than whatever the file holds now, and
  // one that starts while this read runs makes the read stale (revision).
  const revision = mcpConfigRevision;
  await mcpConfigWrite;
  let config: { mcpServers: Record<string, any> };
  try {
    config = JSON.parse(await readFile(configPath, "utf-8")) as {
      mcpServers: Record<string, any>;
    };
  } catch {
    config = { mcpServers: {} };
  }
  // A newer local write, or a path that is no longer the configured one
  // (a watcher event for a previous path), must not replace the cache.
  if (revision !== mcpConfigRevision) return;
  if (configPath !== configuredPaths().mcpConfig) return;
  cachedMcpConfig = config;
  cachedMcpConfigPath = configPath;
}

/** The loaded MCP config, without I/O (see loadMcpConfig). A configured path
 * not loaded yet starts loading and reads as empty until it lands. */
export function readMcpConfig(): { mcpServers: Record<string, any> } {
  const configPath = configuredPaths().mcpConfig;
  setupCacheWatcher(configPath);
  if (cachedMcpConfig && cachedMcpConfigPath === configPath)
    return cachedMcpConfig;
  void loadMcpConfig(configPath);
  return { mcpServers: {} };
}

const LINEAR_AGENT_TOKENS_PATH = `${HOME}/.linear-agent-tokens.json`;

export interface LinearMcpGrant {
  appId: string;
  organizationId: string;
}

export function isOfficialLinearMcpUrl(value: unknown): boolean {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return (
      url.protocol === "https:" &&
      url.hostname === "mcp.linear.app" &&
      !url.port &&
      !url.username &&
      !url.password
    );
  } catch {
    return false;
  }
}

/** Applied after generic credential overlays, without a personal/shared relay. */
export async function withLinearRunGrant(
  cfg: Record<string, unknown>,
  grant: LinearMcpGrant,
): Promise<Record<string, unknown>> {
  if (!isOfficialLinearMcpUrl(cfg.url)) {
    throw new Error(
      "Run-bound Linear MCP requires the official HTTPS endpoint",
    );
  }
  if (!grant.organizationId || !linearAppById(grant.appId)) {
    throw new Error("Run-bound Linear MCP grant is unavailable");
  }
  let token: string | null;
  try {
    token = await getValidToken(
      grant.organizationId,
      getLoadedTokens(grant.appId) ?? (await loadTokens(grant.appId)),
    );
  } catch {
    throw new Error("Run-bound Linear MCP grant is unavailable");
  }
  if (!token) throw new Error("Run-bound Linear MCP grant is unavailable");
  const headers = new Headers();
  if (cfg.headers && typeof cfg.headers === "object") {
    for (const [name, value] of Object.entries(cfg.headers)) {
      if (name.toLowerCase() !== "authorization" && typeof value === "string") {
        headers.set(name, value);
      }
    }
  }
  headers.set("Authorization", `Bearer ${token}`);
  return { ...cfg, headers: Object.fromEntries(headers) };
}

/**
 * Overlay credentials that rotate outside this process. Linear runs as the
 * bot via the linear-agent's OAuth token (actor=app, refreshed by
 * that service) so issues/comments attribute to the bot, not a person. When
 * the token file is missing or stale, the static header in mcp-config.json
 * (personal API key) applies instead. Read per run — never persisted back.
 */
export function withDynamicCredentials(
  servers: Record<string, any>,
  /** Grant identities in priority order (e.g. [session creator, prompter]);
   *  a bare string is treated as a one-element list. First personal grant
   *  wins, then the workspace grant. */
  user?: string | Array<string | undefined>,
): Record<string, any> {
  let out = servers;
  const linear = servers.linear;
  if (isOfficialLinearMcpUrl(linear?.url)) {
    try {
      // Rotated by the linear-agent service; loaded at import and refreshed
      // in the background, at most a second behind the file.
      const tokens: any = cachedJsonFileShared(LINEAR_AGENT_TOKENS_PATH);
      const t: any = Object.values(tokens)[0];
      if (
        t?.accessToken &&
        (!t.expiresAt || t.expiresAt > Date.now() + 60_000)
      ) {
        out = {
          ...out,
          linear: {
            ...linear,
            headers: {
              ...linear.headers,
              Authorization: `Bearer ${t.accessToken}`,
            },
          },
        };
      }
    } catch {}
  }
  // OAuth-connected HTTP servers (src/server/mcp-oauth.ts): inject the run
  // user's own grant first (per-user MCP identity), else the shared grant.
  // Servers with a static Authorization header keep it unless a grant exists.
  try {
    for (const [name, cfg] of Object.entries(out)) {
      if (!cfg || typeof cfg !== "object") continue;
      const c: any = cfg;
      const isHttp = c.type === "http" || c.type === "sse" || !!c.url;
      if (!isHttp) {
        // Stdio servers with a preset OAuth (slack): inject the grant token
        // as the preset's env var (creator-first order) and name the person
        // the run acts for. Slack still posts as its bot: the grant only
        // widens reads, and the person is credited with a "via" line.
        const preset = oauthPresetFor(name);
        if (preset?.envVar && c.command) {
          const candidates = (Array.isArray(user) ? user : [user]).filter(
            (u): u is string => !!u,
          );
          const token =
            candidates
              .map((u) => mcpUserGrantToken(name, u))
              .find((t) => !!t) ??
            mcpSharedGrantHeader(name)?.replace(/^Bearer\s+/i, "");
          const sender = preset.senderEnvVar && candidates[0];
          if (token || sender)
            out = {
              ...out,
              [name]: {
                ...c,
                env: {
                  ...c.env,
                  ...(token ? { [preset.envVar]: token } : {}),
                  ...(sender
                    ? {
                        [preset.senderEnvVar!]:
                          resolveTeammate(sender)?.slackId || sender,
                      }
                    : {}),
                },
              },
            };
        }
        continue;
      }
      const candidates = (Array.isArray(user) ? user : [user]).filter(
        (u): u is string => !!u,
      );
      const header =
        candidates.map((u) => mcpUserGrantHeader(name, u)).find((h) => !!h) ??
        mcpSharedGrantHeader(name);
      if (!header) continue;
      out = {
        ...out,
        [name]: { ...c, headers: { ...c.headers, Authorization: header } },
      };
    }
  } catch (e) {
    console.error("[connections] mcp-oauth header injection failed:", e);
  }
  return out;
}

function writeMcpConfig(config: {
  mcpServers: Record<string, any>;
}): Promise<void> {
  const configPath = configuredPaths().mcpConfig;
  mcpConfigRevision++;
  cachedMcpConfig = config;
  cachedMcpConfigPath = configPath;
  cache = null;
  const run = mcpConfigWrite.then(async () => {
    // Keep one backup so a bad edit is always recoverable
    try {
      await copyFile(configPath, `${configPath}.bak`);
    } catch {}
    await writeFileAtomicAsync(
      configPath,
      JSON.stringify(config, null, 2) + "\n",
    );
  });
  mcpConfigWrite = run.catch(() => {});
  return run;
}

export interface AddMcpInput {
  name: string;
  transport: "http" | "stdio";
  url?: string;
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /**
   * Custom HTTP headers, e.g. `Authorization` or a provider-specific API key
   * header. Stored in mcp-config.json and sent with every request to this
   * server; values are never returned by the connections API.
   */
  headers?: Record<string, string>;
  /**
   * Optional per-user allowlist. When set (non-empty), only sessions whose user
   * resolves (via user-mappings) to one of these people get this server's tools;
   * everyone else's runs never see it. Omitted/empty = available to every
   * session (the default). Entries can be first names, full names, emails,
   * GitHub logins, or Slack ids — matched by userMatchesAny.
   */
  allowedUsers?: string[];
}

/** Normalize an allowedUsers list: trim, drop blanks, dedupe. */
function cleanAllowedUsers(users?: string[]): string[] | undefined {
  if (!Array.isArray(users)) return undefined;
  const out = Array.from(
    new Set(users.map((u) => (u || "").trim()).filter(Boolean)),
  );
  return out.length ? out : undefined;
}

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

/**
 * Validate the HTTP headers the Connections form (or opensession-admin) sends.
 * Returns no headers for an empty/omitted value, and rejects anything Bun's
 * fetch or the MCP transport would treat unexpectedly: malformed names,
 * non-string or blank values, CR/LF injection, and case-insensitive duplicates.
 */
export function cleanMcpHeaders(
  value: unknown,
): { headers?: Record<string, string> } | { error: string } {
  if (value === undefined || value === null) return {};
  if (typeof value !== "object" || Array.isArray(value))
    return { error: "Headers must be an object of name/value pairs" };
  const headers: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [rawName, rawValue] of Object.entries(value)) {
    const name = rawName.trim();
    if (!HEADER_NAME.test(name))
      return { error: `Invalid header name "${rawName}"` };
    if (typeof rawValue !== "string")
      return { error: `Header "${name}" value must be a string` };
    const headerValue = rawValue.trim();
    if (!headerValue) return { error: `Header "${name}" needs a value` };
    if (/[\r\n\0]/.test(headerValue))
      return { error: `Header "${name}" contains invalid characters` };
    const key = name.toLowerCase();
    if (seen.has(key)) return { error: `Duplicate header "${name}"` };
    seen.add(key);
    headers[name] = headerValue;
  }
  return Object.keys(headers).length ? { headers } : {};
}

/** Credentialed first-party release tools must never become fleet-wide. */
export function requiresAllowedUsers(name: string): boolean {
  return name.trim().toLowerCase() === "apple-release";
}

export function hasValidRequiredAllowedUsers(
  value: unknown,
): value is string[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every((user) => typeof user === "string" && Boolean(user.trim()))
  );
}

export async function addMcpServer(
  input: AddMcpInput,
): Promise<{ ok: true } | { error: string }> {
  const name = (input.name || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(name)) {
    return { error: "Name must be alphanumeric (dashes/underscores allowed)" };
  }

  const allowedUsers = cleanAllowedUsers(input.allowedUsers);
  if (requiresAllowedUsers(name) && !allowedUsers) {
    return {
      error: 'Server "apple-release" requires at least one allowed user',
    };
  }
  const parsedHeaders = cleanMcpHeaders(input.headers);
  if ("error" in parsedHeaders) return parsedHeaders;

  const config = readMcpConfig();
  if (config.mcpServers[name]) {
    return { error: `Server "${name}" already exists — remove it first` };
  }

  let entry: any;
  if (input.transport === "http") {
    let parsed: URL;
    try {
      parsed = new URL(input.url || "");
    } catch {
      return { error: "Invalid URL" };
    }
    if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
      return { error: "URL must be http(s)" };
    }
    entry = { type: "http", url: input.url };
    if (parsedHeaders.headers) entry.headers = parsedHeaders.headers;
  } else {
    if (parsedHeaders.headers) {
      return { error: "Headers are only supported for HTTP servers" };
    }
    const command = (input.command || "").trim();
    if (!command) return { error: "Command is required for stdio servers" };
    entry = { command };
    const args = (input.args || []).map((a) => a.trim()).filter(Boolean);
    if (args.length > 0) entry.args = args;
    const env = input.env || {};
    if (Object.keys(env).length > 0) entry.env = env;
  }

  if (allowedUsers) entry.allowedUsers = allowedUsers;

  config.mcpServers[name] = entry;
  await writeMcpConfig(config);
  return { ok: true };
}

/**
 * Install a server entry that is already an entry: the installable-package
 * path (src/server/plugins.ts, scripts/lib/plugins.ts).
 *
 * `addMcpServer` above is the Connections FORM: it builds the entry from
 * typed fields and deliberately drops anything it was not asked for, so a
 * package's extra keys need this whole-entry path. A package's entry arrives
 * whole and has already been validated to carry credential REFERENCES
 * (`${NAME}`) rather than values, so it is written through as-is. `allowedUsers`
 * is the installing operator's call and never the package's, so any allowlist
 * on the incoming entry is discarded in favour of the one passed here.
 */
export async function addMcpServerEntry(
  name: string,
  entry: Record<string, unknown>,
  opts: { allowedUsers?: string[] } = {},
): Promise<{ ok: true } | { error: string }> {
  const clean = (name || "").trim();
  if (!/^[a-z0-9][a-z0-9_-]{0,40}$/i.test(clean)) {
    return { error: "Name must be alphanumeric (dashes/underscores allowed)" };
  }
  const allowedUsers = cleanAllowedUsers(opts.allowedUsers);
  if (requiresAllowedUsers(clean) && !allowedUsers) {
    return {
      error: 'Server "apple-release" requires at least one allowed user',
    };
  }
  const config = readMcpConfig();
  if (config.mcpServers[clean]) {
    return { error: `Server "${clean}" already exists, remove it first` };
  }
  const { allowedUsers: _ignored, ...rest } = entry;
  config.mcpServers[clean] = allowedUsers ? { ...rest, allowedUsers } : rest;
  await writeMcpConfig(config);
  return { ok: true };
}

/** One editor row for a stored name/value map (headers, env). `value: null`
 *  means keep the stored value: the API never sends credentials back, so an
 *  untouched row has nothing new to write. */
export interface McpValueUpdate {
  name: string;
  value: string | null;
}

export interface UpdateMcpInput {
  /** Present only so a stale editor is refused instead of silently rewriting
   *  the server as the other transport. */
  transport?: "http" | "stdio";
  /** A replacement URL. A stored query string survives unless the new URL
   *  carries its own. */
  url?: string;
  command?: string;
  args?: string[];
  headers?: McpValueUpdate[];
  env?: McpValueUpdate[];
  /** Full allowlist; an empty/omitted list clears the restriction. */
  allowedUsers?: string[];
}

function isHttpServer(cfg: any): boolean {
  return cfg?.type === "http" || cfg?.type === "sse" || !!cfg?.url;
}

function storedStringValues(entry: any, key: "headers" | "env") {
  const source = entry?.[key];
  if (!source || typeof source !== "object" || Array.isArray(source)) return {};
  return Object.fromEntries(
    Object.entries(source).filter(([, value]) => typeof value === "string"),
  ) as Record<string, string>;
}

/** Merge the editor's rows into a stored map, keeping values the editor never
 *  saw. `caseInsensitive` is right for HTTP headers and wrong for env keys. */
function mergeMcpValues(
  rows: McpValueUpdate[],
  stored: Record<string, string>,
  label: "Header" | "Env variable",
  opts: { caseInsensitive?: boolean; blankNewValue?: boolean } = {},
): { values: Record<string, string> } | { error: string } {
  const match = (name: string) =>
    opts.caseInsensitive ? name.toLowerCase() : name;
  if (!Array.isArray(rows)) {
    return { error: `${label} rows must be a name/value list` };
  }
  const saved = new Map(
    Object.entries(stored).map(([name, value]) => [match(name), value]),
  );
  const values: Record<string, string> = {};
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row || typeof row !== "object")
      return { error: `${label} rows must have a name and value` };
    const name = typeof row.name === "string" ? row.name.trim() : "";
    const value = typeof row.value === "string" ? row.value.trim() : "";
    if (!name) {
      if (value) return { error: `${label} name is required` };
      continue;
    }
    const key = match(name);
    if (seen.has(key)) {
      return { error: `Duplicate ${label.toLowerCase()} "${name}"` };
    }
    seen.add(key);
    if (!value) {
      const kept = saved.get(key);
      if (kept !== undefined) {
        values[name] = kept;
        continue;
      }
      if (opts.blankNewValue) {
        values[name] = "";
        continue;
      }
      return { error: `${label} "${name}" needs a value` };
    }
    values[name] = value;
  }
  return { values };
}

/**
 * Edit an existing MCP server without losing what the editor cannot see:
 * credential values, a URL's query string, and keys this form does not own
 * (a plugin's `oauthUrl`, comments, …). Only fields present in `input` change.
 */
export async function updateMcpServer(
  name: string,
  input: UpdateMcpInput,
): Promise<
  { ok: true; allowedUsers?: string[] } | { error: string; notFound?: boolean }
> {
  const config = readMcpConfig();
  const entry = config.mcpServers[name];
  if (!entry) return { error: `Server "${name}" not found`, notFound: true };
  const http = isHttpServer(entry);
  if (input.transport && input.transport !== (http ? "http" : "stdio")) {
    return {
      error: "Transport can't be changed. Remove the server and add it again.",
    };
  }

  // Copy first: a rejected field must not leave the cached config mutated.
  const next: Record<string, any> = { ...entry };

  if (http) {
    if (input.env !== undefined) {
      return { error: "Environment is only supported for stdio servers" };
    }
    if (input.command !== undefined || input.args !== undefined) {
      return { error: "Command is only supported for stdio servers" };
    }
    if (input.url !== undefined) {
      let value = typeof input.url === "string" ? input.url.trim() : "";
      let parsed: URL;
      try {
        parsed = new URL(value);
      } catch {
        return { error: "Invalid URL" };
      }
      if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
        return { error: "URL must be http(s)" };
      }
      // The form only ever sees the URL without its query string, so a
      // replacement that omits one inherits the stored query rather than
      // silently dropping the token it carries.
      const previous = typeof entry.url === "string" ? entry.url : "";
      const queryAt = previous.indexOf("?");
      if (!value.includes("?") && queryAt !== -1) {
        value += previous.slice(queryAt);
      }
      next.url = value;
    }
    if (input.headers !== undefined) {
      const merged = mergeMcpValues(
        input.headers,
        storedStringValues(entry, "headers"),
        "Header",
        { caseInsensitive: true },
      );
      if ("error" in merged) return merged;
      const cleaned = cleanMcpHeaders(merged.values);
      if ("error" in cleaned) return cleaned;
      if (cleaned.headers) next.headers = cleaned.headers;
      else delete next.headers;
    }
  } else {
    if (input.url !== undefined || input.headers !== undefined) {
      return { error: "URL and headers are only supported for HTTP servers" };
    }
    if (input.command !== undefined) {
      const command =
        typeof input.command === "string" ? input.command.trim() : "";
      if (!command) return { error: "Command is required for stdio servers" };
      next.command = command;
    }
    if (input.args !== undefined) {
      const args = (Array.isArray(input.args) ? input.args : [])
        .map((arg) => String(arg).trim())
        .filter(Boolean);
      if (args.length > 0) next.args = args;
      else delete next.args;
    }
    if (input.env !== undefined) {
      const merged = mergeMcpValues(
        input.env,
        storedStringValues(entry, "env"),
        "Env variable",
        {
          blankNewValue: true,
        },
      );
      if ("error" in merged) return merged;
      if (Object.keys(merged.values).length > 0) next.env = merged.values;
      else delete next.env;
    }
  }

  if (input.allowedUsers !== undefined) {
    const allowedUsers = cleanAllowedUsers(input.allowedUsers);
    if (requiresAllowedUsers(name) && !allowedUsers) {
      return {
        error: 'Server "apple-release" requires at least one allowed user',
      };
    }
    if (allowedUsers) next.allowedUsers = allowedUsers;
    else delete next.allowedUsers;
    config.mcpServers[name] = next;
    await writeMcpConfig(config);
    return { ok: true, allowedUsers };
  }

  config.mcpServers[name] = next;
  await writeMcpConfig(config);
  return { ok: true };
}

export async function replaceMcpServerEntries(
  updates: Record<string, Record<string, unknown> | undefined>,
): Promise<{ ok: true } | { error: string }> {
  const config = readMcpConfig();
  for (const [name, entry] of Object.entries(updates)) {
    const allowedUsers = cleanAllowedUsers(
      Array.isArray(entry?.allowedUsers)
        ? (entry.allowedUsers as string[])
        : undefined,
    );
    if (entry && requiresAllowedUsers(name) && !allowedUsers) {
      return {
        error: `Server "${name}" requires at least one allowed user`,
      };
    }
  }
  for (const [name, entry] of Object.entries(updates)) {
    if (entry) config.mcpServers[name] = entry;
    else delete config.mcpServers[name];
  }
  await writeMcpConfig(config);
  return { ok: true };
}

export async function removeMcpServer(
  name: string,
): Promise<{ ok: true } | { error: string }> {
  const config = readMcpConfig();
  if (!config.mcpServers[name]) return { error: `Server "${name}" not found` };
  delete config.mcpServers[name];
  await writeMcpConfig(config);
  return { ok: true };
}

export interface McpConnection {
  name: string;
  transport: "http" | "stdio";
  target: string; // sanitized: origin+path for http, command for stdio
  /** stdio: the executable and args the edit form prefills. */
  command?: string;
  args?: string[];
  /** http: the stored URL without its query string, which may carry a token. */
  url?: string;
  /** http: a query string is stored and survives an edit that omits one. */
  urlHasQuery?: boolean;
  /** http: configured header names. Values are never exposed. */
  headerNames?: string[];
  envKeys: string[];
  status:
    | "connected"
    | "ready"
    | "needs-env"
    | "needs-auth"
    | "unreachable"
    | "missing";
  detail?: string;
  /** Per-user allowlist, if this server is restricted (empty/absent = everyone). */
  allowedUsers?: string[];
}

let cache: { data: McpConnection[]; ts: number } | null = null;
const TTL = 60_000;

export async function getConnections(force = false): Promise<McpConnection[]> {
  if (!force && cache && Date.now() - cache.ts < TTL) return cache.data;

  const servers = readMcpConfig().mcpServers;
  const results = await Promise.all(
    Object.entries(servers).map(async ([name, cfg]) => {
      const conn = await checkServer(name, cfg);
      const allowedUsers = cleanAllowedUsers(cfg?.allowedUsers);
      if (allowedUsers) conn.allowedUsers = allowedUsers;
      if (isHttpServer(cfg)) {
        const url = typeof cfg?.url === "string" ? cfg.url : "";
        const queryAt = url.indexOf("?");
        if (url) conn.url = queryAt === -1 ? url : url.slice(0, queryAt);
        if (queryAt !== -1) conn.urlHasQuery = true;
        const headerNames =
          cfg?.headers &&
          typeof cfg.headers === "object" &&
          !Array.isArray(cfg.headers)
            ? Object.keys(cfg.headers)
            : [];
        if (headerNames.length > 0) conn.headerNames = headerNames;
      } else {
        if (typeof cfg?.command === "string") conn.command = cfg.command;
        if (Array.isArray(cfg?.args)) {
          const args = cfg.args.filter(
            (arg: unknown): arg is string => typeof arg === "string",
          );
          if (args.length > 0) conn.args = args;
        }
      }
      return conn;
    }),
  );

  cache = { data: results, ts: Date.now() };
  return results;
}

async function checkServer(name: string, cfg: any): Promise<McpConnection> {
  const isHttp = isHttpServer(cfg);

  if (isHttp) {
    let target = cfg.url || "";
    try {
      const u = new URL(cfg.url);
      target = `${u.origin}${u.pathname}`;
    } catch {}

    try {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), 4000);
      // Any HTTP response (incl. 401/405) means the endpoint is up;
      // MCP servers typically reject bare GETs but still answer.
      const res = await fetch(cfg.url, {
        method: "GET",
        // Configured headers may be what makes the endpoint answer at all.
        headers:
          cfg.headers && typeof cfg.headers === "object"
            ? cfg.headers
            : undefined,
        signal: controller.signal,
      });
      clearTimeout(timer);
      // Reachable, but an OAuth-protected server with no grant and no static
      // credentials isn't usable yet — surface "Sign in required" instead of a
      // misleading "Connected" (the GET's 401/405 only proves the endpoint is
      // up). Any configured header may be the credential (Authorization, an
      // API-key header, …), so its presence means this is not an OAuth gap.
      const hasConfiguredHeaders =
        !!cfg.headers &&
        typeof cfg.headers === "object" &&
        Object.keys(cfg.headers).length > 0;
      if (!hasConfiguredHeaders) {
        try {
          const st = mcpOauthStatus(name);
          if (!st.shared && st.users.length === 0) {
            if (supportsManualToken(name)) {
              return {
                name,
                transport: "http",
                target,
                envKeys: Object.keys(cfg.env || {}),
                status: "needs-auth",
                detail: "API token required. Connect from this card's menu",
              };
            }
            if (await isOauthCapable(cfg.url)) {
              return {
                name,
                transport: "http",
                target,
                envKeys: Object.keys(cfg.env || {}),
                status: "needs-auth",
                detail:
                  "OAuth sign-in required — Connect from this card's menu",
              };
            }
          }
        } catch {}
      }
      return {
        name,
        transport: "http",
        target,
        envKeys: Object.keys(cfg.env || {}),
        status: "connected",
        detail: `HTTP ${res.status}`,
      };
    } catch (e: any) {
      return {
        name,
        transport: "http",
        target,
        envKeys: Object.keys(cfg.env || {}),
        status: "unreachable",
        detail:
          e.name === "AbortError"
            ? "timeout"
            : (e.message || "fetch failed").slice(0, 80),
      };
    }
  }

  // stdio: verify the executable / script exists and required env is present
  const command: string = cfg.command || "";
  const args: string[] = cfg.args || [];
  const envKeys = Object.keys(cfg.env || {});
  const target = [command, ...args].join(" ");

  // Resolve what must exist on disk: absolute command, or first absolute arg
  // (covers "bun run /path/to/script.ts")
  const pathsToCheck = [command, ...args].filter((p) => p.startsWith("/"));
  const exists = await Promise.all(
    pathsToCheck.map((p) =>
      stat(p).then(
        () => true,
        () => false,
      ),
    ),
  );
  const missing = pathsToCheck.find((_, i) => !exists[i]);
  if (missing) {
    return {
      name,
      transport: "stdio",
      target,
      envKeys,
      status: "missing",
      detail: `not found: ${missing}`,
    };
  }

  const missingEnv = envKeys.filter((k) => {
    const v = cfg.env?.[k];
    // Values like "${PLAIN_API_KEY}" or empty mean: must come from process env
    const isRef = typeof v === "string" && (v === "" || v.includes("${"));
    return isRef ? !process.env[k] : false;
  });
  if (missingEnv.length > 0) {
    return {
      name,
      transport: "stdio",
      target,
      envKeys,
      status: "needs-env",
      detail: `missing: ${missingEnv.join(", ")}`,
    };
  }

  return { name, transport: "stdio", target, envKeys, status: "ready" };
}

await Promise.all([
  loadMcpConfig(),
  loadJsonFileShared(LINEAR_AGENT_TOKENS_PATH).catch(() => undefined),
]);
