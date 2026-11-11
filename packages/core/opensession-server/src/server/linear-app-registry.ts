import { configuredIntegration, configuredServer } from "./config";
import type { LinearStartMode } from "../agents/linear/start-mode";

export interface LinearApp {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
  startMode?: LinearStartMode;
}

const warnedStartModes = new Set<string>();

/** Accept only a known mode; a hand-edited invalid value falls back to the
 *  unset default. Warnings are deduplicated because this projection is read
 *  for every app list and session setup. */
function startMode(
  value: unknown,
  source: string,
): LinearStartMode | undefined {
  if (value === "ask" || value === "plan" || value === "implement")
    return value;
  if (value === undefined || value === null) return undefined;
  const warning = `${source}=${String(value).slice(0, 80)}`;
  if (warnedStartModes.size < 32 && !warnedStartModes.has(warning)) {
    warnedStartModes.add(warning);
    console.warn(
      `[linear] Unknown start mode from ${source}; using the default`,
    );
  }
  return undefined;
}

export function validAdditionalLinearAppId(id: unknown): id is string {
  return (
    typeof id === "string" &&
    id !== "primary" &&
    /^[a-z0-9][a-z0-9-]{0,62}$/.test(id)
  );
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function linearApps(): LinearApp[] {
  const config = configuredIntegration("linear");
  const apps: LinearApp[] = [
    {
      id: "primary",
      name: text(config.name) || "Linear",
      clientId:
        text(process.env.LINEAR_CLIENT_ID) || text(config.oauthClientId),
      clientSecret:
        text(process.env.LINEAR_CLIENT_SECRET) ||
        text(config.oauthClientSecret),
      webhookSecret:
        text(process.env.LINEAR_WEBHOOK_SECRET) || text(config.webhookSecret),
      startMode: startMode(config.startMode, "integrations.linear.startMode"),
    },
  ];
  const ids = new Set(["primary"]);
  if (!Array.isArray(config.apps)) return apps;
  for (const raw of config.apps) {
    if (!raw || typeof raw !== "object" || Array.isArray(raw)) continue;
    const id = "id" in raw ? text(raw.id) : "";
    const name = "name" in raw ? text(raw.name) : "";
    const clientId = "oauthClientId" in raw ? text(raw.oauthClientId) : "";
    if (!validAdditionalLinearAppId(id) || ids.has(id) || !clientId) continue;
    ids.add(id);
    apps.push({
      id,
      name: name || "Linear",
      clientId,
      clientSecret:
        "oauthClientSecret" in raw ? text(raw.oauthClientSecret) : "",
      webhookSecret: "webhookSecret" in raw ? text(raw.webhookSecret) : "",
      startMode: startMode(
        "startMode" in raw ? raw.startMode : undefined,
        `integrations.linear.apps.${id}.startMode`,
      ),
    });
  }
  return apps;
}

export function linearAppById(id: string): LinearApp | null {
  return linearApps().find((app) => app.id === id) ?? null;
}

export function linearWebhookPath(appId = "primary"): string {
  return appId === "primary" ? "/webhook" : `/linear/webhook/${appId}`;
}

export function linearAuthorizePath(appId = "primary"): string {
  return appId === "primary"
    ? "/oauth/authorize"
    : `/linear/oauth/${appId}/authorize`;
}

/** Every Linear app returns to the same gateway callback. The OAuth state
 *  carries the app id, so the callback can select that app's credentials. */
export function linearCallbackPath(): string {
  return "/oauth/callback";
}

/** App-scoped callback from the first multi-app release. Kept so an
 *  authorization started before the shared callback can still finish. */
export function linearLegacyCallbackPath(appId: string): string {
  return appId === "primary"
    ? linearCallbackPath()
    : `/linear/oauth/${appId}/callback`;
}

export function linearRedirectUri(): string {
  const configured = text(configuredIntegration("linear").oauthRedirectUrl);
  return (
    configured ||
    `${configuredServer().webhookBaseUrl.replace(/\/+$/, "")}${linearCallbackPath()}`
  );
}

export function linearLegacyRedirectUri(app: LinearApp): string {
  return `${configuredServer().webhookBaseUrl.replace(/\/+$/, "")}${linearLegacyCallbackPath(app.id)}`;
}
