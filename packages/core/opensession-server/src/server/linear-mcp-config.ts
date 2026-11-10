import { isOfficialLinearMcpUrl } from "./connections";
import { mcpServerAllowedForRun } from "./runner-shared";

/** A logical `linear` mount keeps the configured server's access policy. */
export function runBoundLinearMcpConfig(opts: {
  servers: Record<string, unknown>;
  user?: string;
  grantUsers?: Array<string | undefined>;
}): Record<string, unknown> {
  const permitted = (name: string, cfg: Record<string, unknown>) =>
    mcpServerAllowedForRun(name, cfg.allowedUsers, opts.user, opts.grantUsers);
  const transportConfig = (cfg: Record<string, unknown>) => {
    const {
      allowedUsers: _allowedUsers,
      oauthUrl: _oauthUrl,
      ...transport
    } = cfg;
    return transport;
  };
  const canonical = opts.servers.linear;
  if (Object.hasOwn(opts.servers, "linear")) {
    if (!isConfig(canonical) || !isOfficialLinearMcpUrl(canonical.url)) {
      throw new Error(
        "Run-bound Linear MCP requires the official HTTPS endpoint",
      );
    }
    if (!permitted("linear", canonical)) {
      throw new Error("Run-bound Linear MCP is unavailable for this run");
    }
    return transportConfig(canonical);
  }

  let hasAlias = false;
  for (const [name, cfg] of Object.entries(opts.servers)) {
    if (!isConfig(cfg) || !isOfficialLinearMcpUrl(cfg.url)) continue;
    hasAlias = true;
    if (permitted(name, cfg)) return transportConfig(cfg);
  }
  if (hasAlias)
    throw new Error("Run-bound Linear MCP is unavailable for this run");
  return { type: "http", url: "https://mcp.linear.app/mcp" };
}

function isConfig(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}
