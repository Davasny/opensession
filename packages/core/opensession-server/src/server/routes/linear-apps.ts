import { randomUUID } from "node:crypto";
import { configuredServer } from "../config";
import {
  persistRawConfigAsync,
  rawConfig,
  withConfigMutationLock,
} from "../config-mutation";
import {
  linearAppById,
  linearApps,
  linearAuthorizePath,
  linearRedirectUri,
  linearWebhookPath,
  validAdditionalLinearAppId,
} from "../linear-app-registry";
import type { LinearApp } from "../linear-app-registry";
import { webAuthRequired } from "../web-auth";
import {
  createAutomation,
  deleteAutomation,
  listAutomations,
  updateAutomation,
} from "../automations";
import type { Automation } from "../automations";
import type { RouteContext } from "./context";
import {
  readRequestTextWithinLimit,
  RequestBodyTooLargeError,
} from "../shared/bounded-body";

const APPS_PATH = "/api/connections/linear/apps";
const FIELDS = ["name", "oauthClientId", "oauthClientSecret", "webhookSecret"];
const MAX_BODY_BYTES = 128 * 1024;
const FIELD_LIMITS: Record<string, number> = {
  name: 200,
  oauthClientId: 1024,
  oauthClientSecret: 8192,
  webhookSecret: 8192,
};
const AUTOMATION_FIELDS = [
  "prompt",
  "mode",
  "model",
  "mcpServers",
  "enabled",
  "repo",
];
type AutomationPatch = Partial<
  Pick<
    Automation,
    "prompt" | "mode" | "model" | "mcpServers" | "enabled" | "repo"
  >
>;

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function summary(app: LinearApp, automation: Automation | undefined) {
  const base = configuredServer().webhookBaseUrl.replace(/\/+$/, "");
  return {
    id: app.id,
    name: app.name,
    clientId: app.clientId,
    clientSecretConfigured: !!app.clientSecret,
    webhookConfigured: !!app.webhookSecret,
    authorizeUrl: `${base}${linearAuthorizePath(app.id)}`,
    callbackUrl: linearRedirectUri(),
    webhookUrl: `${base}${linearWebhookPath(app.id)}`,
    automationEventKey: `linear:agent_session:${app.id}`,
    automation: automation
      ? {
          id: automation.id,
          prompt: automation.prompt,
          mode: automation.mode,
          model: automation.model ?? null,
          mcpServers: automation.mcpServers ?? [],
          enabled: automation.enabled,
          repo: automation.repo ?? null,
        }
      : null,
  };
}

export async function handleLinearAppsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  const { req, path } = ctx;
  if (path !== APPS_PATH && !path.startsWith(`${APPS_PATH}/`)) return undefined;
  if (ctx.authUser?.automation)
    return Response.json(
      { error: "Not available to automations" },
      { status: 403 },
    );
  if (webAuthRequired() && !ctx.authUser?.login)
    return Response.json(
      { error: "Sign in to manage Linear apps" },
      { status: 403 },
    );

  if (path === APPS_PATH && req.method === "GET") {
    const automations = await listAutomations();
    return Response.json({
      apps: linearApps().map((app) =>
        summary(
          app,
          automations.find(
            (automation) =>
              automation.eventKey === `linear:agent_session:${app.id}`,
          ),
        ),
      ),
    });
  }
  const creating = path === APPS_PATH && req.method === "POST";
  const id = creating ? randomUUID() : path.slice(APPS_PATH.length + 1);
  if (!creating && id !== "primary" && !validAdditionalLinearAppId(id))
    return Response.json({ error: "Unknown Linear app" }, { status: 404 });
  if (req.method === "DELETE" && id === "primary")
    return Response.json(
      { error: "The primary Linear app cannot be removed" },
      { status: 400 },
    );
  if (!creating && req.method !== "PUT" && req.method !== "DELETE")
    return undefined;

  let body: unknown = {};
  if (req.method !== "DELETE") {
    try {
      body = JSON.parse(await readRequestTextWithinLimit(req, MAX_BODY_BYTES));
    } catch (error) {
      return Response.json(
        {
          error:
            error instanceof RequestBodyTooLargeError
              ? "Request body too large"
              : "Invalid JSON body",
        },
        { status: error instanceof RequestBodyTooLargeError ? 413 : 400 },
      );
    }
  }
  if (
    !record(body) ||
    Object.keys(body).some(
      (key) => !FIELDS.includes(key) && key !== "automation",
    ) ||
    FIELDS.some((key) => key in body && typeof body[key] !== "string")
  )
    return Response.json(
      {
        error:
          "Use name, oauthClientId, oauthClientSecret, webhookSecret, and automation fields",
      },
      { status: 400 },
    );
  const automationPatch: AutomationPatch = {};
  for (const [field, limit] of Object.entries(FIELD_LIMITS)) {
    const value = body[field];
    if (typeof value === "string" && value.length > limit)
      return Response.json(
        { error: `${field} exceeds ${limit} characters` },
        { status: 400 },
      );
  }
  if ("automation" in body) {
    const patch = body.automation;
    if (
      !record(patch) ||
      Object.keys(patch).some((key) => !AUTOMATION_FIELDS.includes(key))
    )
      return Response.json(
        { error: "Unsupported automation field" },
        { status: 400 },
      );
    for (const key of ["prompt", "model", "repo"]) {
      if (key in patch && typeof patch[key] !== "string")
        return Response.json(
          { error: `Automation ${key} must be a string` },
          { status: 400 },
        );
    }
    for (const [field, limit] of Object.entries({
      prompt: 65536,
      model: 512,
      repo: 256,
    })) {
      const value = patch[field];
      if (typeof value === "string" && value.length > limit)
        return Response.json(
          { error: `Automation ${field} exceeds ${limit} characters` },
          { status: 400 },
        );
    }
    if (
      "mode" in patch &&
      patch.mode !== "scratch" &&
      patch.mode !== "code" &&
      patch.mode !== "ask"
    )
      return Response.json(
        { error: "Invalid automation mode" },
        { status: 400 },
      );
    if ("enabled" in patch && typeof patch.enabled !== "boolean")
      return Response.json(
        { error: "Automation enabled must be a boolean" },
        { status: 400 },
      );
    if (
      "mcpServers" in patch &&
      (!Array.isArray(patch.mcpServers) ||
        patch.mcpServers.length > 100 ||
        !patch.mcpServers.every(
          (value: unknown) => typeof value === "string" && value.length <= 256,
        ))
    )
      return Response.json(
        { error: "Automation mcpServers must be a string array" },
        { status: 400 },
      );
    if (typeof patch.prompt === "string") automationPatch.prompt = patch.prompt;
    if (typeof patch.model === "string") automationPatch.model = patch.model;
    if (typeof patch.repo === "string") automationPatch.repo = patch.repo;
    if (
      patch.mode === "scratch" ||
      patch.mode === "code" ||
      patch.mode === "ask"
    )
      automationPatch.mode = patch.mode;
    if (typeof patch.enabled === "boolean")
      automationPatch.enabled = patch.enabled;
    if (Array.isArray(patch.mcpServers))
      automationPatch.mcpServers = patch.mcpServers.filter(
        (value: unknown): value is string => typeof value === "string",
      );
  }
  if (
    (creating || (id !== "primary" && "oauthClientId" in body)) &&
    (typeof body.oauthClientId !== "string" || !body.oauthClientId.trim())
  )
    return Response.json(
      { error: "OAuth client id required" },
      { status: 400 },
    );

  try {
    return await withConfigMutationLock(async () => {
      const config = await rawConfig();
      const integrations = record(config.integrations)
        ? config.integrations
        : {};
      const linear = record(integrations.linear) ? integrations.linear : {};
      let apps: unknown[] = Array.isArray(linear.apps) ? linear.apps : [];
      const index = apps.findIndex((entry) => record(entry) && entry.id === id);
      if (!creating && id !== "primary" && index < 0)
        return Response.json({ error: "Unknown Linear app" }, { status: 404 });
      if (creating && index >= 0)
        return Response.json(
          { error: "App id collision; try again" },
          { status: 409 },
        );
      if (id === "primary" && req.method === "PUT") {
        const envFields: Record<string, string | undefined> = {
          oauthClientId: process.env.LINEAR_CLIENT_ID,
          oauthClientSecret: process.env.LINEAR_CLIENT_SECRET,
          webhookSecret: process.env.LINEAR_WEBHOOK_SECRET,
        };
        if (
          Object.entries(envFields).some(([field, value]) => {
            const submitted = body[field];
            return (
              typeof submitted === "string" &&
              submitted.trim() &&
              value?.trim() &&
              submitted.trim() !== value.trim()
            );
          })
        ) {
          return Response.json(
            {
              error:
                "These primary app credentials are managed by environment variables. Update the environment instead.",
            },
            { status: 409 },
          );
        }
      }
      const storedApp = id === "primary" ? linear : apps[index];
      const storedClientId =
        id === "primary" && process.env.LINEAR_CLIENT_ID?.trim()
          ? process.env.LINEAR_CLIENT_ID.trim()
          : record(storedApp) && typeof storedApp.oauthClientId === "string"
            ? storedApp.oauthClientId.trim()
            : "";
      if (
        !creating &&
        req.method === "PUT" &&
        storedClientId &&
        typeof body.oauthClientId === "string" &&
        body.oauthClientId.trim() !== storedClientId
      ) {
        return Response.json(
          {
            error:
              "The OAuth client id cannot be changed. Create a new app instead.",
          },
          { status: 409 },
        );
      }
      const eventKey = `linear:agent_session:${id}`;
      let automation: Automation | undefined = (await listAutomations()).find(
        (entry) => entry.eventKey === eventKey,
      );
      const previousAutomation = automation;
      let createdAutomation: string | undefined;
      if (creating || (req.method === "PUT" && "automation" in body)) {
        const result = automation
          ? await updateAutomation(automation.id, automationPatch)
          : await createAutomation({
              name: `Linear: ${(typeof body.name === "string" ? body.name.trim() : linearAppById(id)?.name) || "Linear"}`,
              prompt:
                "Complete the assigned Linear task and report the result in Linear.",
              mode: "scratch",
              mcpServers: [],
              enabled: true,
              ...automationPatch,
              schedule: "",
              eventKey,
              createdBy: ctx.authUser?.login || "Settings",
            });
        if ("error" in result)
          return Response.json({ error: result.error }, { status: 400 });
        if (!automation) createdAutomation = result.id;
        automation = result;
      }
      if (req.method === "DELETE") {
        apps = apps.filter((entry) => !record(entry) || entry.id !== id);
      } else {
        const existing = apps[index];
        const target =
          id === "primary" ? linear : record(existing) ? existing : { id };
        for (const field of FIELDS) {
          const value = body[field];
          if (typeof value !== "string") continue;
          if (
            req.method === "PUT" &&
            (field === "oauthClientSecret" || field === "webhookSecret") &&
            !value.trim()
          )
            continue;
          if (
            id === "primary" &&
            ((field === "oauthClientId" &&
              process.env.LINEAR_CLIENT_ID?.trim()) ||
              (field === "oauthClientSecret" &&
                process.env.LINEAR_CLIENT_SECRET?.trim()) ||
              (field === "webhookSecret" &&
                process.env.LINEAR_WEBHOOK_SECRET?.trim()))
          )
            continue;
          target[field] = value.trim();
        }
        if (creating) apps.push(target);
      }
      if (apps.length) linear.apps = apps;
      else delete linear.apps;
      integrations.linear = linear;
      config.integrations = integrations;
      try {
        await persistRawConfigAsync(config);
      } catch (error) {
        if (createdAutomation) await deleteAutomation(createdAutomation);
        else if (
          previousAutomation &&
          "automation" in body &&
          req.method === "PUT"
        ) {
          const rollback: AutomationPatch = {};
          if ("prompt" in automationPatch)
            rollback.prompt = previousAutomation.prompt;
          if ("mode" in automationPatch)
            rollback.mode = previousAutomation.mode;
          if ("model" in automationPatch)
            rollback.model = previousAutomation.model;
          if ("repo" in automationPatch)
            rollback.repo = previousAutomation.repo;
          if ("mcpServers" in automationPatch)
            rollback.mcpServers = previousAutomation.mcpServers;
          if ("enabled" in automationPatch)
            rollback.enabled = previousAutomation.enabled;
          const restored = await updateAutomation(
            previousAutomation.id,
            rollback,
          );
          if ("error" in restored)
            console.error("[linear-apps] Automation rollback rejected", {
              automationId: previousAutomation.id,
            });
        }
        throw error;
      }
      const app = linearAppById(id);
      return Response.json(
        req.method === "DELETE"
          ? { ok: true }
          : { app: app ? summary(app, automation) : null },
        { status: creating ? 201 : 200 },
      );
    });
  } catch {
    return Response.json(
      { error: "Could not save Linear apps" },
      { status: 500 },
    );
  }
}
