import { linearAgentConfig } from "../agents/linear/agent-config";
import { getValidToken, loadTokens } from "../agents/linear/oauth";
import { agentSessionCatalogSource } from "./agent-session-catalog";
import { linearAppById } from "./linear-app-registry";
import type { UnifiedSession } from "./types";

const dependencies = {
  source: (key: string) => agentSessionCatalogSource("linear", key),
  config: linearAgentConfig,
  app: linearAppById,
  token: async (appId: string, organizationId: string) =>
    Boolean(await getValidToken(organizationId, await loadTokens(appId))),
};

/** UI turns keep the connector's app identity without exposing its credential. */
export async function linearSessionRunInputs(
  session: Pick<UnifiedSession, "id" | "source" | "model" | "mode">,
  deps = dependencies,
) {
  if (session.source !== "linear") return null;
  const source = await deps.source(session.id.slice("linear-".length));
  if (!source) throw new Error("This Linear session is no longer available");
  const stored = source.data;
  const appId = stored.appId ?? "primary";
  const config = await deps.config(appId);
  // Old primary sessions predate app profiles. Keep their existing behavior
  // until a profile is configured, but never downgrade an explicitly owned run.
  if (
    (config && !config.enabled) ||
    (((stored.appId && stored.appId !== "primary") || stored.automationId) &&
      !config) ||
    (stored.automationId && config?.id !== stored.automationId)
  ) {
    throw new Error("This Linear agent is disabled or no longer configured");
  }
  if (!stored.appId && !config) {
    return { mode: stored.executionMode ?? session.mode };
  }
  const app = deps.app(appId);
  if (!app?.clientId || !app.clientSecret) {
    throw new Error("This Linear app is no longer configured");
  }
  if (
    !stored.organizationId ||
    !(await deps.token(appId, stored.organizationId))
  ) {
    throw new Error("Reconnect this Linear app to the session's organization");
  }
  return {
    mode: stored.executionMode ?? session.mode,
    model: stored.model || config?.model || session.model,
    instructions: config?.prompt,
    mcpServers: config ? (config.mcpServers ?? []) : undefined,
    linearGrant: { appId, organizationId: stored.organizationId },
  };
}
