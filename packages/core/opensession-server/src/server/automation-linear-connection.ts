import { getLoadedTokens, loadTokens } from "../agents/linear/oauth";
import {
  loadMcpConfig,
  readMcpConfig,
  withLinearRunGrant,
  type LinearMcpGrant,
} from "./connections";
import { runBoundLinearMcpConfig } from "./linear-mcp-config";
import { linearApps } from "./linear-app-registry";

export interface AutomationLinearConnection extends LinearMcpGrant {
  appName: string;
  organizationName?: string;
}

/** Connection choices contain identifiers only, never OAuth credentials. */
export async function listAutomationLinearConnections(): Promise<
  AutomationLinearConnection[]
> {
  const connections: AutomationLinearConnection[] = [];
  for (const app of linearApps()) {
    if (!app.clientId || !app.clientSecret) continue;
    const tokens = getLoadedTokens(app.id) ?? (await loadTokens(app.id));
    for (const [organizationId, token] of Object.entries(tokens)) {
      if (
        !token.accessToken ||
        (token.expiresAt &&
          token.expiresAt <= Date.now() &&
          !token.refreshToken)
      )
        continue;
      connections.push({ appId: app.id, appName: app.name, organizationId });
    }
  }
  return connections;
}

export async function parseAutomationLinearConnection(
  value: unknown,
): Promise<LinearMcpGrant | undefined | { error: string }> {
  if (value === null || value === undefined) return undefined;
  if (
    typeof value !== "object" ||
    Array.isArray(value) ||
    !("appId" in value) ||
    !("organizationId" in value) ||
    typeof value.appId !== "string" ||
    typeof value.organizationId !== "string" ||
    !value.appId.trim() ||
    !value.organizationId.trim() ||
    Object.keys(value).some(
      (key) => key !== "appId" && key !== "organizationId",
    )
  )
    return { error: "linearConnection must contain appId and organizationId" };

  const grant = {
    appId: value.appId.trim(),
    organizationId: value.organizationId.trim(),
  };
  const connections = await listAutomationLinearConnections();
  return connections.some(
    (connection) =>
      connection.appId === grant.appId &&
      connection.organizationId === grant.organizationId,
  )
    ? grant
    : { error: "Linear connection is unavailable" };
}

/** Check before launch without personal access identities, including on resumes. */
export async function automationLinearGrant(
  grant: LinearMcpGrant | undefined,
): Promise<LinearMcpGrant | undefined> {
  if (!grant) return undefined;
  await loadMcpConfig();
  const cfg = runBoundLinearMcpConfig({
    servers: readMcpConfig().mcpServers,
  });
  await withLinearRunGrant(cfg, grant);
  return { appId: grant.appId, organizationId: grant.organizationId };
}
