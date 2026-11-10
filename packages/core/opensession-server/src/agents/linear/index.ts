/**
 * Linear Agent Module — handles Linear agent sessions, OAuth, and issue webhooks.
 */
import type { AgentModule } from "../types";
import { verifyLinearSignature } from "../../server/shared/signature";
import {
  MAX_WEBHOOK_BODY_BYTES,
  RequestBodyTooLargeError,
  readRequestTextWithinLimit,
  webhookBodyTooLargeResponse,
} from "../../server/shared/bounded-body";
import {
  getLoadedTokens,
  loadTokens,
  handleAuthorize,
  handleCallback,
} from "./oauth";
import type { LinearTokens } from "./oauth";
import { handleAgentSession, handleIssueUpdate } from "./handlers";
import {
  agentSessionWebhookSchema,
  issueWebhookSchema,
} from "./webhook-schema";
import { activeSessions, loadActiveSessionsOnStartup } from "./session";
import {
  linearApps,
  linearAppById,
  validAdditionalLinearAppId,
} from "../../server/linear-app-registry";

export class LinearAgent implements AgentModule {
  name = "linear";
  private tokens = new Map<string, Promise<LinearTokens>>();

  private appTokens(appId: string): Promise<LinearTokens> {
    let loaded = this.tokens.get(appId);
    if (!loaded) {
      const current = getLoadedTokens(appId);
      loaded = (current ? Promise.resolve(current) : loadTokens(appId)).catch(
        (error) => {
          this.tokens.delete(appId);
          throw error;
        },
      );
      this.tokens.set(appId, loaded);
    }
    return loaded;
  }

  getRoutes(): Map<string, (req: Request, url: URL) => Promise<Response>> {
    const routes = new Map<
      string,
      (req: Request, url: URL) => Promise<Response>
    >();

    // Webhook endpoint
    const webhook = async (req: Request, appId: string) => {
      const app = linearAppById(appId);
      if (!app)
        return Response.json({ error: "Unknown Linear app" }, { status: 404 });
      let body: string;
      try {
        body = await readRequestTextWithinLimit(req, MAX_WEBHOOK_BODY_BYTES);
      } catch (error) {
        if (error instanceof RequestBodyTooLargeError)
          return webhookBodyTooLargeResponse(MAX_WEBHOOK_BODY_BYTES);
        throw error;
      }
      const signature = req.headers.get("linear-signature") || "";

      if (!verifyLinearSignature(body, signature, app.webhookSecret)) {
        console.error("[linear] Invalid webhook signature");
        return Response.json({ error: "Invalid signature" }, { status: 401 });
      }

      let payload: unknown;
      try {
        payload = JSON.parse(body);
      } catch {
        return Response.json(
          { error: "Invalid webhook body" },
          { status: 400 },
        );
      }
      if (
        !payload ||
        typeof payload !== "object" ||
        !("type" in payload) ||
        !("action" in payload)
      )
        return Response.json(
          { error: "Invalid webhook body" },
          { status: 400 },
        );
      console.log(`[linear] Webhook: ${payload.type} - ${payload.action}`);
      const tokens = await this.appTokens(appId);

      if (
        payload.type === "AgentSessionEvent" ||
        payload.type === "AgentSession"
      ) {
        const parsed = agentSessionWebhookSchema.safeParse(payload);
        if (!parsed.success)
          return Response.json(
            { error: "Invalid agent session" },
            { status: 400 },
          );
        return handleAgentSession(parsed.data, tokens, appId);
      }

      if (payload.type === "Issue") {
        const parsed = issueWebhookSchema.safeParse(payload);
        if (!parsed.success)
          return Response.json(
            { error: "Invalid issue event" },
            { status: 400 },
          );
        return handleIssueUpdate(parsed.data, tokens, appId);
      }

      return Response.json({ ok: true });
    };
    routes.set("POST /webhook", (req) => webhook(req, "primary"));
    routes.set("POST /linear/webhook/*", async (req, url) => {
      const id = url.pathname.slice("/linear/webhook/".length);
      if (!validAdditionalLinearAppId(id))
        return Response.json({ error: "Unknown Linear app" }, { status: 404 });
      return webhook(req, id);
    });

    // OAuth
    routes.set("GET /oauth/authorize", async () => {
      return handleAuthorize("primary");
    });

    routes.set("GET /oauth/callback", async (req, url) => {
      return handleCallback(
        req,
        url,
        await this.appTokens("primary"),
        "primary",
      );
    });
    routes.set("GET /linear/oauth/*", async (req, url) => {
      const parts = url.pathname.slice("/linear/oauth/".length).split("/");
      const [id, action] = parts;
      if (
        parts.length !== 2 ||
        !validAdditionalLinearAppId(id) ||
        !linearAppById(id)
      )
        return Response.json({ error: "Unknown Linear app" }, { status: 404 });
      if (action === "authorize") return handleAuthorize(id);
      if (action === "callback")
        return handleCallback(req, url, await this.appTokens(id), id);
      return new Response(null, { status: 404 });
    });

    return routes;
  }

  async startup(): Promise<void> {
    for (const app of linearApps()) {
      await loadActiveSessionsOnStartup(await this.appTokens(app.id), app.id);
    }
    console.log("[linear] Agent started");
  }

  async shutdown(): Promise<void> {
    for (const [, session] of activeSessions) {
      if (session.abortController) {
        session.abortController.abort();
      }
    }
    console.log("[linear] Agent shut down");
  }

  health(): Record<string, unknown> {
    return {
      status: "operational",
      activeSessions: activeSessions.size,
      sessions: Array.from(activeSessions.values()).map((s) => ({
        branch: s.branch,
        issue: s.issueIdentifier,
        isPlanning: s.phase === "planning",
      })),
    };
  }
}
