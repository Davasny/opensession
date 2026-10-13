/**
 * Stripe approval-request events (`v2.core.approval_request.*`).
 *
 * Stripe sends these as thin events from an event destination: the payload
 * names the approval request, and the rest is fetched with the Stripe key the
 * agent uses (an agent key only sees its own requests, which are the ones that
 * matter here). Each event posts to `integrations.stripe.approvalsSlackChannel`
 * and, once a request is decided, tells the session that asked for it. The
 * session comes from the marker guardStripeApprovalCall stamps on the reason.
 */
import { configuredPaths } from "../../server/config";
import {
  STRIPE_APPROVAL_SESSION_MARKER,
  stripeApprovalsSlackChannel,
} from "../../server/stripe-approvals";
import { sessionLink } from "../../server/run-instructions";

export const APPROVAL_EVENT_PREFIX = "v2.core.approval_request.";
const STRIPE_API_VERSION = "2026-09-30.preview";
const APPROVAL_ID = /^apreq_[A-Za-z0-9]+$/;

export interface StripeThinEvent {
  id: string;
  type: string;
  livemode?: boolean;
  related_object?: { id?: string; type?: string; url?: string } | null;
}

export interface ApprovalRequest {
  id: string;
  action?: string;
  status?: string;
  reason?: string | null;
  dashboard_url?: string;
  expires_at?: string;
  rule?: { name?: string } | null;
  review?: unknown;
}

type Outcome =
  | "created"
  | "approved"
  | "rejected"
  | "canceled"
  | "expired"
  | "succeeded"
  | "failed";

const OUTCOMES = new Set<Outcome>([
  "created",
  "approved",
  "rejected",
  "canceled",
  "expired",
  "succeeded",
  "failed",
]);

/** Outcomes the requesting session is told about: the request is settled. */
const SESSION_OUTCOMES = new Set<Outcome>([
  "rejected",
  "expired",
  "succeeded",
  "failed",
]);

/** `approved` is always followed by `succeeded` or `failed`; `canceled` is
 *  the requester withdrawing it, which the session already knows. */
const SLACK_OUTCOMES = new Set<Outcome>([
  "created",
  "rejected",
  "expired",
  "succeeded",
  "failed",
]);

export function approvalOutcome(type: string): Outcome | null {
  if (!type.startsWith(APPROVAL_EVENT_PREFIX)) return null;
  const tail = type.slice(APPROVAL_EVENT_PREFIX.length) as Outcome;
  return OUTCOMES.has(tail) ? tail : null;
}

/** The session id from the last server-stamped marker in a reason. Only a
 *  link to this server's own session URL counts. */
export function approvalSessionId(
  reason: string | null | undefined,
): string | null {
  if (!reason) return null;
  const base = sessionLink("");
  let found: string | null = null;
  for (const line of reason.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed.startsWith(STRIPE_APPROVAL_SESSION_MARKER)) continue;
    const url = trimmed.slice(STRIPE_APPROVAL_SESSION_MARKER.length).trim();
    if (!url.startsWith(base)) continue;
    const id = url.slice(base.length);
    if (/^[A-Za-z0-9-]{1,80}$/.test(id)) found = id;
  }
  return found;
}

/** Slack mrkdwn control characters; also defuses `<!channel>` style pings. */
function slackEscape(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

const OUTCOME_LABEL: Record<Outcome, string> = {
  created: "needs review",
  approved: "was approved",
  rejected: "was rejected",
  canceled: "was canceled",
  expired: "expired without a review",
  succeeded: "was approved and went through",
  failed: "was approved but Stripe failed to carry it out",
};

function actionLabel(action: string | undefined): string {
  if (action === "refund.create") return "Refund";
  if (action === "subscription.cancel") return "Subscription cancellation";
  return action ? `Stripe action ${action}` : "Stripe action";
}

function dashboardUrl(request: ApprovalRequest): string {
  return (
    request.dashboard_url ||
    `https://dashboard.stripe.com/settings/approvals/requests/${request.id}`
  );
}

/** The reason as the model wrote it, without the server's marker line. */
function reasonBody(reason: string | null | undefined): string {
  return (reason || "")
    .split("\n")
    .filter((l) => !l.trim().startsWith(STRIPE_APPROVAL_SESSION_MARKER))
    .join("\n")
    .trim();
}

export function slackApprovalText(
  outcome: Outcome,
  request: ApprovalRequest,
  sessionId: string | null,
): string {
  const lines = [
    `*${actionLabel(request.action)} ${OUTCOME_LABEL[outcome]}* (<${dashboardUrl(request)}|${request.id}>)`,
  ];
  const reason = reasonBody(request.reason);
  if (reason) lines.push(`> ${slackEscape(reason).replace(/\n+/g, " ")}`);
  if (outcome === "created" && request.expires_at)
    lines.push(
      `Review before ${request.expires_at.replace("T", " ").replace(/\.\d+Z$|Z$/, " UTC")}, or it lapses and nothing happens.`,
    );
  if (sessionId) lines.push(`<${sessionLink(sessionId)}|Requesting session>`);
  return lines.join("\n");
}

export function sessionApprovalNotice(
  outcome: Outcome,
  request: ApprovalRequest,
): string {
  const what = `${actionLabel(request.action)} approval request ${request.id}`;
  const next: Record<string, string> = {
    succeeded:
      "Stripe carried out the action. Confirm it in Stripe if you need ids, then tell the person it is done.",
    failed:
      "A reviewer approved it, but Stripe could not carry it out. Nothing moved. Check Stripe for the reason and tell the person.",
    rejected:
      "A reviewer rejected it. Nothing moved. Tell the person, and do not submit it again unless they ask.",
    expired:
      "Nobody reviewed it in time, so it lapsed and nothing moved. Tell the person; submit it again only if they ask.",
  };
  return [
    `[Stripe] ${what} ${OUTCOME_LABEL[outcome]}.`,
    next[outcome] || "",
    `Request: ${dashboardUrl(request)}`,
  ]
    .filter(Boolean)
    .join("\n");
}

/** The bearer the Stripe MCP server uses, read without blocking. An explicit
 *  `STRIPE_API_KEY` wins. */
async function stripeKey(): Promise<string | null> {
  const fromEnv = process.env.STRIPE_API_KEY?.trim();
  if (fromEnv) return fromEnv;
  try {
    const config = (await Bun.file(configuredPaths().mcpConfig).json()) as {
      mcpServers?: Record<string, { headers?: Record<string, string> }>;
    };
    const header = config.mcpServers?.stripe?.headers?.Authorization || "";
    const key = header.replace(/^Bearer\s+/i, "").trim();
    return key || null;
  } catch {
    return null;
  }
}

async function fetchApprovalRequest(
  id: string,
  fetchImpl: typeof fetch,
): Promise<ApprovalRequest | null> {
  const key = await stripeKey();
  if (!key) return null;
  const res = await fetchImpl(
    `https://api.stripe.com/v2/core/approval_requests/${id}`,
    {
      headers: {
        Authorization: `Bearer ${key}`,
        "Stripe-Version": STRIPE_API_VERSION,
      },
      signal: AbortSignal.timeout(15_000),
    },
  );
  if (!res.ok) {
    console.warn(`[stripe] approval request ${id}: HTTP ${res.status}`);
    return null;
  }
  return (await res.json()) as ApprovalRequest;
}

const seenEvents = new Set<string>();
/** Slack thread per approval request, so later updates reply under the
 *  "needs review" post. Lost on restart; then they post at the top level. */
const slackThreads = new Map<string, string>();

export interface ApprovalEventDeps {
  fetchImpl?: typeof fetch;
  postSlack?: (
    channel: string,
    text: string,
    threadTs?: string,
  ) => Promise<string | undefined>;
  deliver?: (
    sessionId: string,
    text: string,
    eventId: string,
  ) => Promise<boolean>;
}

async function defaultPostSlack(
  channel: string,
  text: string,
  threadTs?: string,
): Promise<string | undefined> {
  if (!process.env.SLACK_BOT_TOKEN) return undefined;
  const { slackApiCall } = await import("../slack/slack-api");
  const res = await slackApiCall("chat.postMessage", {
    channel,
    text,
    unfurl_links: false,
    unfurl_media: false,
    ...(threadTs ? { thread_ts: threadTs } : {}),
  });
  return res?.ok ? (res.ts as string) : undefined;
}

async function defaultDeliver(
  sessionId: string,
  text: string,
  eventId: string,
): Promise<boolean> {
  const [{ findSession }, { tryGetSessionControl }] = await Promise.all([
    import("../../server/session-cache"),
    import("../../server/session-control"),
  ]);
  const control = tryGetSessionControl();
  if (!control || !findSession(sessionId)) return false;
  const result = await control.deliverToSession(sessionId, text, undefined, {
    busy: "queue",
    deliveryId: `stripe-${eventId}`,
  });
  return result.status !== "error";
}

/** Handle one verified approval-request thin event. Returns what it did. */
export async function handleApprovalEvent(
  event: StripeThinEvent,
  deps: ApprovalEventDeps = {},
): Promise<{ slack: boolean; session: string | null }> {
  const done = { slack: false, session: null as string | null };
  const outcome = approvalOutcome(event.type);
  const id = event.related_object?.id;
  if (!outcome || !id || !APPROVAL_ID.test(id)) return done;
  if (seenEvents.has(event.id)) return done;
  seenEvents.add(event.id);
  if (seenEvents.size > 2000) seenEvents.clear();

  const request = (await fetchApprovalRequest(
    id,
    deps.fetchImpl ?? fetch,
  ).catch((e) => {
    console.warn(`[stripe] approval request ${id} fetch failed:`, e);
    return null;
  })) ?? { id };
  const sessionId = approvalSessionId(request.reason);

  const channel = stripeApprovalsSlackChannel();
  if (channel && SLACK_OUTCOMES.has(outcome)) {
    const ts = await (deps.postSlack ?? defaultPostSlack)(
      channel,
      slackApprovalText(outcome, request, sessionId),
      slackThreads.get(id),
    ).catch((e) => {
      console.warn(`[stripe] approval Slack post failed:`, e);
      return undefined;
    });
    if (ts) {
      done.slack = true;
      if (outcome === "created") {
        if (slackThreads.size > 2000) slackThreads.clear();
        slackThreads.set(id, ts);
      }
    }
  }

  if (sessionId && SESSION_OUTCOMES.has(outcome)) {
    await (deps.deliver ?? defaultDeliver)(
      sessionId,
      sessionApprovalNotice(outcome, request),
      event.id,
    )
      .then((delivered) => {
        if (delivered) done.session = sessionId;
      })
      .catch((e) =>
        console.warn(`[stripe] approval notice to ${sessionId} failed:`, e),
      );
  }
  console.log(
    `[stripe] ${event.type} ${id} → slack=${done.slack} session=${done.session ?? "-"}`,
  );
  return done;
}
