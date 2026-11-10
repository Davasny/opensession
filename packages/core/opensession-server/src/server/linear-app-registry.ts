import { configuredIntegration, configuredServer } from "./config";

export interface LinearApp {
  id: string;
  name: string;
  clientId: string;
  clientSecret: string;
  webhookSecret: string;
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

export function linearCallbackPath(appId = "primary"): string {
  return appId === "primary"
    ? "/oauth/callback"
    : `/linear/oauth/${appId}/callback`;
}

export function linearRedirectUri(app: LinearApp): string {
  const configured = text(configuredIntegration("linear").oauthRedirectUrl);
  return app.id === "primary" && configured
    ? configured
    : `${configuredServer().webhookBaseUrl.replace(/\/+$/, "")}${linearCallbackPath(app.id)}`;
}
