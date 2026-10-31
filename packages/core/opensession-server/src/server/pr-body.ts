/**
 * The pull-request body contract shared by every flow that publishes a PR.
 *
 * A run that writes code owns the description of that code. The server owns
 * the parts a run must not forge: the ticket link, requester metadata, the
 * session-attribution footer, and the public-repository safety gate. Keeping
 * both halves here means the Linear wrapper, the generic runner instructions,
 * the walkthrough mirror, and the PR cache all agree on one format.
 */

import { personaName } from "./config";

/** Agents that can open the PR themselves put their description after this
 *  line. Linear uses it because its wrapper, not the agent, runs
 *  `gh pr create`; the marker keeps working notes out of the body. */
export const PR_BODY_SENTINEL = "===OPENSESSION-PR-BODY===";

/** Managed section markers around the agent-authored description. A later
 *  implementation turn replaces only this section, so human edits elsewhere
 *  in the PR body survive. */
export const PR_BODY_SECTION_START = "<!-- opensession:pr-body -->";
export const PR_BODY_SECTION_END = "<!-- /opensession:pr-body -->";

/** Marker the Linear implementation prompt uses to end its turn. */
export const LINEAR_IMPLEMENTATION_COMPLETE = "IMPLEMENTATION_COMPLETE";

/** GitHub's own limit is 65,536 characters. Leave a small margin for the
 *  ticket and footer blocks appended around an agent-authored body. */
const MAX_AGENT_BODY = 60_000;

/**
 * The session link out of a PR body's attribution footer.
 *
 * The footer is the one contract `pr-cache` uses to attach a PR to a session
 * when the PR sits on a branch the session does not own. Keep the link text
 * anchored on "this … session": a body that merely links to some session in
 * passing must not claim the PR for it.
 */
export const PR_ATTRIBUTION_FOOTER_RE =
  /\n*(?:Started by|Created by) .*\[this [^\]]* session\]\([^)]*\)[^\n]*\s*$/;

export function sessionRefFromPrBody(
  body: string | null | undefined,
): string | undefined {
  const m = body?.match(
    /\[this [^\]]*session\]\((?:https?:\/\/[^)\s]+?)?\/session\/([A-Za-z0-9._~-]+)/i,
  );
  return m?.[1];
}

/** The reviewer-facing description an agent emitted, or "" when it did not. */
export function extractAgentPrBody(
  text: string,
  endMarker: string = LINEAR_IMPLEMENTATION_COMPLETE,
): string {
  if (!text) return "";
  const start = text.lastIndexOf(PR_BODY_SENTINEL);
  if (start === -1) return "";
  const after = text.slice(start + PR_BODY_SENTINEL.length);
  const end = endMarker ? after.indexOf(endMarker) : -1;
  const body = (end === -1 ? after : after.slice(0, end)).trim();
  return body.length > MAX_AGENT_BODY
    ? `${body.slice(0, MAX_AGENT_BODY).replace(/\s+\S*$/, "")}\n…`
    : body;
}

/** The short text meant for the Linear timeline, before the PR body. */
export function extractAgentSummary(
  text: string,
  endMarker: string = LINEAR_IMPLEMENTATION_COMPLETE,
): string {
  if (!text) return "";
  const start = text.indexOf(PR_BODY_SENTINEL);
  const before = start === -1 ? text : text.slice(0, start);
  return before.replace(new RegExp(`\\b${endMarker}\\b\\s*$`), "").trim();
}

export interface PrTicket {
  identifier: string;
  title: string;
  url?: string;
}

export interface ComposePrBodyInput {
  /** Markdown the agent wrote for reviewers. Empty = use the fallback. */
  agentBody?: string;
  ticket: PrTicket;
  /** Names shown as "Requested by" / "Participants" on a private repo. */
  participants?: readonly string[];
  /** Default checklist used only when the agent wrote no description. */
  testPlan?: readonly string[];
  /** The exact "Started by … in [this … session](…)" line. */
  footer?: string;
}

/**
 * Compose a PR body from the agent's description and the server-owned blocks.
 *
 * The agent's body comes first and the ticket block follows it. When the agent
 * wrote nothing, the historical summary + test plan remains the fallback. The
 * footer is always last so `spliceWalkthroughSection` and the PR cache can
 * find it with one anchored pattern.
 */
export function composePrBody(input: ComposePrBodyInput): string {
  const ticketLine = `Implements ${input.ticket.identifier}: ${input.ticket.title}`;
  const agentBody = input.agentBody?.trim() || "";
  const blocks: string[] = [];

  if (agentBody) {
    blocks.push(
      `${PR_BODY_SECTION_START}\n${agentBody}\n${PR_BODY_SECTION_END}`,
    );
    blocks.push(`## Ticket\n${ticketLine}`);
    if (input.ticket.url) blocks.push(input.ticket.url);
  } else {
    blocks.push(`## Summary\n${ticketLine}`);
    if (input.ticket.url) blocks.push(input.ticket.url);
    const testPlan = (input.testPlan || []).map((item) => `- [ ] ${item}`);
    if (testPlan.length > 0)
      blocks.push(`## Test plan\n${testPlan.join("\n")}`);
  }

  const participants = (input.participants || []).filter(Boolean);
  if (participants.length > 0) {
    const names = participants.join(", ");
    const label = participants.length === 1 ? "Requested by" : "Participants";
    blocks.push(`**${label}:** ${names} (via Linear)`);
  }

  const footer = input.footer?.trim();
  if (footer) blocks.push(footer);

  return `${blocks.join("\n\n").trimEnd()}\n`;
}

/**
 * Replace the managed agent-description section in an existing PR body.
 *
 * A body without the markers is left untouched. That covers two cases the
 * server must not overwrite: a PR that predates this contract, and a person
 * who deliberately removed the managed section. `updatePrBody` skips a no-op
 * write, so returning the body unchanged is safe.
 */
export function spliceAgentPrBody(body: string, agentBody: string): string {
  const next = agentBody.trim();
  if (!next) return body;
  const start = body.indexOf(PR_BODY_SECTION_START);
  const end = body.indexOf(PR_BODY_SECTION_END);
  if (start === -1 || end === -1 || end < start) return body;
  const section = `${PR_BODY_SECTION_START}\n${next}\n${PR_BODY_SECTION_END}`;
  return (
    body.slice(0, start) +
    section +
    body.slice(end + PR_BODY_SECTION_END.length)
  );
}

/** The first configured private term the text contains, if any. */
export function findPrivateTerm(
  text: string,
  terms: readonly string[],
): string | undefined {
  const lower = text.toLowerCase();
  return terms
    .map((term) => term.trim())
    .filter((term) => term.length >= 3)
    .find((term) => lower.includes(term.toLowerCase()));
}

/**
 * The session-attribution footer every session-opened PR carries.
 *
 * `sessionUrl` must be the private app origin's `/session/<id>` URL. The
 * footer is the only place a public PR may name the session that produced it.
 */
export function prAttributionFooter(input: {
  sessionUrl: string;
  author?: string | null;
  persona?: string;
}): string {
  const persona = input.persona?.trim() || personaName();
  const author = input.author?.trim();
  return author
    ? `Started by ${author} in [this ${persona} session](${input.sessionUrl})`
    : `Created by [this ${persona} session](${input.sessionUrl})`;
}
