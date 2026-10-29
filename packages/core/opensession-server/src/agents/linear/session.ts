/**
 * Linear agent session lifecycle and the headless agent runner.
 */
import {
  completeAgentSessionCatalogSources,
  agentSessionSourceKey,
} from "../../server/agent-session-catalog";
import { STRIPE_CONFIRM_TOOLS } from "../../server/runner-shared";
import { shouldPersistModelSwitch } from "../../server/run-events";
import { runAgent, cancelAgentRun } from "../../server/agent-runner";
import {
  configuredServer,
  defaultRepo,
  personaName,
  productName,
} from "../../server/config";
import { getDefaultModel, toPiModel } from "../../server/models";
import { writeJsonAtomicAsync } from "../../server/shared/atomic-write";
import { publishSessionChange } from "../../server/session-cache";
import {
  createWorktree as createRepoWorktree,
  removeWorktree,
  resolveUniqueBranch,
  sharedCheckoutForNewSessions,
  repoForPathOrNull,
} from "../../server/worktree";
import { githubServiceCredentialEnv } from "../../server/github-app";
import { rm } from "fs/promises";
import { homeDir } from "../../server/paths";
import {
  gitIdentityFor,
  gitIdentityEnv,
} from "../../server/shared/user-mappings";
import { createAgentActivity } from "./api";
import type { LinearTokens } from "./oauth";
import { getValidToken } from "./oauth";
import type { LinearStartMode } from "./start-mode";
import {
  isAgentSessionFileKey,
  isLinearSessionTerminal,
  linearSessionFilePath,
  linearSessionFileKey,
  linearSessionIdFromFileKey,
  linearUnifiedSessionId,
  markLinearSessionTerminal,
  withSessionStoreWrite,
} from "./session-store";

export { linearSessionFileKey, linearUnifiedSessionId } from "./session-store";

/** Sessions with no activity for this long aren't restored on startup. */
const STALE_SESSION_MS = 7 * 24 * 60 * 60 * 1000;

// --- Types ---

export interface Participant {
  id: string;
  name: string;
  email: string | null;
}

const PHASES = [
  "awaiting_direction",
  "planning",
  "awaiting_implementation",
  "working",
] as const;

/**
 * Where a session is in its lifecycle. One value at a time, so a combination
 * the previous three booleans could express but no code path meant, such as
 * "awaiting direction while planning", is now unrepresentable.
 */
export type SessionPhase = (typeof PHASES)[number];

/** Durable claim for the one automatic turn a plan/implement assignment starts. */
export interface LinearAssignmentStart {
  mode: Exclude<LinearStartMode, "ask">;
  status: "pending" | "dispatched" | "completed" | "failed" | "cancelled";
  claimedAt: string;
  settledAt?: string;
  noticeAt?: string;
}

/**
 * The fields kept in `<branch>.json`. Saves take a Partial of this and
 * startup hydration spreads the whole record into the live session, so every
 * field the save writes is read back by construction.
 */
export interface StoredSession {
  branch: string;
  claudeSessionId: string | null;
  issueIdentifier: string;
  issueTitle: string;
  worktreeDir: string;
  /** "" when the file predates the Linear agent-session id being recorded. */
  linearSessionId: string;
  phase: SessionPhase;
  issueId: string;
  issueUrl: string;
  participants: Participant[];
  lastActiveUser: Participant | null;
  issueCreator: Participant | null;
  /** Model id for this session's runs (from the session file); unset = default. */
  model?: string;
  /** Workspace link established at creation; absent means setup is incomplete. */
  workspaceId?: string;
  /** The repo and checkout ownership chosen when the worktree was created. */
  repoId?: string;
  ownsWorktree?: boolean;
  /** Set after the Linear greeting activity landed, so a replay can finish a
   *  failed setup without posting it twice. */
  greetingPostedAt?: string;
  /** Stable timestamp for the transcript greeting. */
  greetingAt?: string;
  /** Locked for this assignment so a config change cannot re-route it. */
  startMode?: LinearStartMode;
  /** One automatic assignment turn, claimed before the runner starts. */
  assignmentStart?: LinearAssignmentStart;
  /** Linear agent-activity ids whose prompted turn was already claimed. A
   *  webhook redelivered after a restart must not run the same message twice. */
  processedPromptIds?: string[];
  updatedAt?: string;
}

/** A stored session plus the parts that only exist while the process runs. */
export interface ActiveSession extends StoredSession {
  /** The store file this session is persisted in. Current files are keyed by
   *  the Linear agent-session id; legacy files are keyed by branch. */
  sessionKey: string;
  accessToken: string;
  issueDescription: string;
  teamId: string;
  abortController?: AbortController;
  /** A `created` webhook's worktree/setup promise. Prompts arriving before the
   *  worktree exists wait on it instead of guessing a path. */
  ready?: Promise<void>;
  /** Set once this exact session was ended/dismissed. A late run completion
   *  must not revive its file or touch a replacement. */
  ended?: boolean;
  /** A stop signal arrived before the runner had an abort controller. */
  stopRequested?: boolean;
  /** Set by endLinearSession when `worktreeDir` was still empty because the
   *  created flow was mid-setup. That flow removes the checkout once it knows
   *  the real path; end cannot remove a path it never saw. */
  cleanupCreatedWorktree?: boolean;
  planningConversation: Array<{
    role: "agent" | "user";
    content: string;
    timestamp: string;
  }>;
}

/** In-memory active sessions: linearSessionId -> ActiveSession */
export const activeSessions = new Map<string, ActiveSession>();

/** Dedup set for webhook sessions */
export const processedSessions = new Set<string>();

// --- Utilities ---

export function extractPrUrl(result: string): string | null {
  const prUrlMatch = result.match(
    /https:\/\/github\.com\/[^\/]+\/[^\/]+\/pull\/\d+/,
  );
  return prUrlMatch ? prUrlMatch[0] : null;
}

export function formatConversationHistory(
  conversation: Array<{
    role: "agent" | "user";
    content: string;
    timestamp: string;
  }>,
): string {
  if (conversation.length === 0) return "";
  return conversation
    .map(
      (msg) =>
        `**${msg.role === "user" ? "User" : personaName()}:** ${msg.content}`,
    )
    .join("\n\n");
}

export function buildParticipantSections(
  participants: Participant[],
  lastActiveUser: Participant | null,
): { participantsSection: string; coAuthorInstruction: string } {
  let participantsSection = "";
  let coAuthorInstruction = "";

  if (participants.length > 0) {
    const names = participants.map((p) => p.name).join(", ");
    participantsSection = `\n**Requested by:** ${names} (via Linear)\n`;
  }

  if (lastActiveUser) {
    const email =
      lastActiveUser.email || `${lastActiveUser.id}@users.linear.app`;
    coAuthorInstruction = `IMPORTANT: When creating commits, include this Co-Authored-By line:
Co-Authored-By: ${lastActiveUser.name} <${email}>`;
  }

  return { participantsSection, coAuthorInstruction };
}

// --- Branch & Worktree ---

export function generateBranchName(
  title: string,
  issueIdentifier?: string,
): string {
  // Heuristic: take first 1-2 words from title, lowercased, hyphen-separated, no special chars
  // Avoids a full Haiku query just for a branch name.
  const words = title
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, "") // Remove special chars
    .split(/\s+/) // Split on whitespace
    .filter((w) => w.length > 0) // Remove empty strings
    .slice(0, 2) // Take first 2 words
    .join("-") // Hyphenate
    .slice(0, 30); // Max 30 chars

  let branch = words || "task";

  if (issueIdentifier) {
    const suffix = issueIdentifier.toLowerCase().replace(/[^a-z0-9]/g, "");
    branch = `${branch}-${suffix}`;
  }

  return branch;
}

/**
 * Create the isolated checkout for a new Linear agent session and return the
 * branch and path that actually exist. A reassigned issue regenerates the same
 * branch, so an isolated repo gets a unique suffix instead of reusing (or
 * failing on) the previous session's branch. A shared-checkout repo keeps its
 * one live checkout by design; `createRepoWorktree` returns that path.
 */
export async function createSessionWorktree(desiredBranch: string): Promise<{
  branch: string;
  worktreeDir: string;
  ownsWorktree: boolean;
  repoId: string;
}> {
  const repo = defaultRepo();
  const shared = sharedCheckoutForNewSessions(repo);
  let branch = shared
    ? desiredBranch
    : await resolveUniqueBranch(desiredBranch, repo.id);
  try {
    const worktreeDir = await createRepoWorktree(branch, repo.id);
    console.log(`[linear] Created worktree: ${branch} at ${worktreeDir}`);
    return { branch, worktreeDir, ownsWorktree: !shared, repoId: repo.id };
  } catch (error) {
    // Two creates for the same ticket can resolve the same name. Re-resolve
    // once now that the first attempt may have registered the branch.
    if (shared) throw error;
    const retry = await resolveUniqueBranch(branch, repo.id);
    if (retry === branch) throw error;
    const worktreeDir = await createRepoWorktree(retry, repo.id);
    console.log(`[linear] Created worktree: ${retry} at ${worktreeDir}`);
    return {
      branch: retry,
      worktreeDir,
      ownsWorktree: true,
      repoId: repo.id,
    };
  }
}

// --- Session persistence ---

/** A blank record, so a partial save always has every field to merge onto. */
function emptyStored(branch: string): StoredSession {
  return {
    branch,
    claudeSessionId: null,
    issueIdentifier: "",
    issueTitle: "",
    worktreeDir: "",
    linearSessionId: "",
    phase: "working",
    issueId: "",
    issueUrl: "",
    participants: [],
    lastActiveUser: null,
    issueCreator: null,
  };
}
/**
 * Read one session file, migrating files written before `phase` replaced the
 * three booleans. `awaitingInitialDirection` was only ever written as true and
 * never cleared, so on those files it means "awaiting direction" only while
 * there is no engine session id: once a turn has run, direction was given.
 */
function storedFromFile(
  sessionKey: string,
  raw: Record<string, any>,
): StoredSession {
  const claudeSessionId = raw.claudeSessionId ?? null;
  const phase: SessionPhase = (PHASES as readonly string[]).includes(raw.phase)
    ? raw.phase
    : raw.awaitingInitialDirection && !claudeSessionId
      ? "awaiting_direction"
      : raw.awaitingImplementationConfirmation
        ? "awaiting_implementation"
        : "working";

  return {
    // Current files carry the branch inside a key that is the agent-session id;
    // legacy files are named after the branch and often omit the field.
    branch:
      typeof raw.branch === "string" && raw.branch ? raw.branch : sessionKey,
    claudeSessionId,
    issueIdentifier: raw.issueIdentifier ?? "",
    issueTitle: raw.issueTitle ?? "",
    worktreeDir: raw.worktreeDir ?? "",
    linearSessionId: raw.linearSessionId ?? "",
    phase,
    issueId: raw.issueId ?? "",
    issueUrl: raw.issueUrl ?? "",
    participants: raw.participants ?? [],
    lastActiveUser: raw.lastActiveUser ?? null,
    issueCreator: raw.issueCreator ?? null,
    model: raw.model ?? undefined,
    workspaceId: raw.workspaceId ?? undefined,
    repoId: raw.repoId ?? undefined,
    ownsWorktree:
      typeof raw.ownsWorktree === "boolean" ? raw.ownsWorktree : undefined,
    greetingPostedAt: raw.greetingPostedAt ?? undefined,
    greetingAt: raw.greetingAt ?? undefined,
    startMode: raw.startMode ?? undefined,
    assignmentStart: raw.assignmentStart ?? undefined,
    processedPromptIds: Array.isArray(raw.processedPromptIds)
      ? raw.processedPromptIds.filter(
          (id: unknown): id is string => typeof id === "string",
        )
      : undefined,
    updatedAt: raw.updatedAt,
  };
}

async function readStoredFile(
  sessionKey: string,
): Promise<StoredSession | null> {
  const path = linearSessionFilePath(sessionKey);
  if (!path) return null;
  try {
    const file = Bun.file(path);
    if (await file.exists()) {
      return storedFromFile(sessionKey, JSON.parse(await file.text()));
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Merge a patch over the stored session: named fields move, everything else
 * keeps what is on disk. A key left out (or explicitly undefined) is a
 * deliberate "keep the stored value", not a miscounted argument slot.
 *
 * The file is keyed by `sessionKey` (agent-session id for current sessions,
 * branch for legacy ones), never by `patch.branch`: two agent sessions on the
 * same issue share a branch but must never share a file. A write that would
 * relabel an existing file with a different agent-session id is refused, so a
 * late run cannot take over the store record of a replacement.
 */
export async function saveSessionInfo(
  sessionKey: string,
  patch: Partial<StoredSession>,
  isLive?: () => boolean,
): Promise<boolean> {
  const path = linearSessionFilePath(sessionKey);
  if (!path) return false;
  const defined = Object.fromEntries(
    Object.entries(patch).filter(([, v]) => v !== undefined),
  ) as Partial<StoredSession>;

  let wrote = false;
  await withSessionStoreWrite(path, async () => {
    // Liveness is re-checked INSIDE the per-file write lock: an end that runs
    // between the caller's pre-check and this queued write must win, not be
    // undone by a late save recreating the record.
    if (isLive && !isLive()) return;
    const existing = await readStoredFile(sessionKey);
    const keyOwner = linearSessionIdFromFileKey(sessionKey);
    if (
      keyOwner &&
      defined.linearSessionId &&
      defined.linearSessionId !== keyOwner
    ) {
      console.warn(
        `[linear] Refusing to write agent session ${defined.linearSessionId} into ${sessionKey}`,
      );
      return;
    }
    if (
      existing?.linearSessionId &&
      defined.linearSessionId &&
      existing.linearSessionId !== defined.linearSessionId
    ) {
      console.warn(
        `[linear] Refusing to relabel session file ${sessionKey} from ${existing.linearSessionId} to ${defined.linearSessionId}`,
      );
      return;
    }
    const owner =
      defined.linearSessionId ||
      existing?.linearSessionId ||
      keyOwner ||
      undefined;
    if (owner && (await isLinearSessionTerminal(owner))) {
      console.warn(
        `[linear] Refusing to write ended Linear session ${owner} (${sessionKey})`,
      );
      return;
    }
    const data: StoredSession = {
      ...emptyStored(isAgentSessionFileKey(sessionKey) ? "" : sessionKey),
      ...(existing || {}),
      ...defined,
      updatedAt: new Date().toISOString(),
    };
    if (!data.branch) data.branch = sessionKey;
    await writeJsonAtomicAsync(path, data);
    wrote = true;
  });
  if (!wrote) return false;
  // The list index and the catalog projection learn this file only from a
  // targeted publish; the gateway never lists the directory.
  await publishSessionChange(linearUnifiedSessionId(sessionKey));
  return true;
}

export async function loadSessionInfo(
  sessionKey: string,
): Promise<StoredSession | null> {
  return readStoredFile(sessionKey);
}

export interface StoredSessionLocation {
  /** The store file key, not the branch. */
  key: string;
  session: StoredSession;
}

/**
 * The stored session an incoming Linear agent-session id may operate on.
 * Current sessions are keyed by that id. A legacy `<branch>.json` is accepted
 * only when its recorded `linearSessionId` matches exactly; a branch match
 * with a different (or missing) id is the old collision and must never be
 * adopted. An unknown id therefore starts clean instead of inheriting the
 * previous agent session's transcript.
 */
export async function findStoredSessionForAgentSession(
  linearSessionId: string,
  branch: string,
): Promise<StoredSessionLocation | null> {
  let key = "";
  try {
    key = linearSessionFileKey(linearSessionId);
  } catch {
    key = "";
  }
  if (key) {
    const stored = await loadSessionInfo(key);
    if (stored?.linearSessionId === linearSessionId)
      return { key, session: stored };
  }
  if (branch) {
    const stored = await loadSessionInfo(branch);
    if (stored?.linearSessionId === linearSessionId)
      return { key: branch, session: stored };
  }
  return null;
}

/**
 * Remove the record this agent session owns. With an expected id, a file that
 * belongs to a different session is left alone. Returns whether the record is
 * gone (a missing file counts as gone, since there is nothing left to revive).
 */
export async function deleteSessionFile(
  sessionKey: string,
  expectedLinearSessionId?: string,
): Promise<boolean> {
  const path = linearSessionFilePath(sessionKey);
  if (!path) return false;
  const keyOwner = linearSessionIdFromFileKey(sessionKey);
  if (
    expectedLinearSessionId &&
    keyOwner &&
    keyOwner !== expectedLinearSessionId
  ) {
    console.warn(
      `[linear] Refusing to delete session file ${sessionKey}: keyed by ${keyOwner}, not ${expectedLinearSessionId}`,
    );
    return false;
  }
  let gone = false;
  await withSessionStoreWrite(path, async () => {
    const existing = await readStoredFile(sessionKey);
    if (!existing) {
      // A missing file counts as gone; an unreadable one is left for its owner
      // rather than guessed at.
      gone = !(await Bun.file(path).exists());
      return;
    }
    if (
      expectedLinearSessionId &&
      existing.linearSessionId !== expectedLinearSessionId
    ) {
      console.warn(
        `[linear] Refusing to delete session file ${sessionKey}: owned by ${existing.linearSessionId || "(no id)"}, not ${expectedLinearSessionId}`,
      );
      return;
    }
    await rm(path, { force: true });
    gone = true;
  });
  if (gone) {
    console.log(`[linear] Deleted session file: ${path}`);
    await publishSessionChange(linearUnifiedSessionId(sessionKey));
  }
  return gone;
}

/**
 * Persist this exact live session. False when it was ended or replaced while a
 * run was in flight: its late completion must not recreate the record or write
 * into the replacement's file.
 */
export async function persistActiveSession(
  session: ActiveSession,
): Promise<boolean> {
  const live = () =>
    !session.ended && activeSessions.get(session.linearSessionId) === session;
  if (!live()) return false;
  const wrote = await saveSessionInfo(
    session.sessionKey,
    {
      branch: session.branch,
      claudeSessionId: session.claudeSessionId,
      issueIdentifier: session.issueIdentifier,
      issueTitle: session.issueTitle,
      worktreeDir: session.worktreeDir,
      linearSessionId: session.linearSessionId,
      phase: session.phase,
      issueId: session.issueId,
      issueUrl: session.issueUrl,
      participants: session.participants,
      lastActiveUser: session.lastActiveUser,
      issueCreator: session.issueCreator,
      model: session.model,
      workspaceId: session.workspaceId,
      repoId: session.repoId,
      ownsWorktree: session.ownsWorktree,
      greetingPostedAt: session.greetingPostedAt,
      greetingAt: session.greetingAt,
      startMode: session.startMode,
      assignmentStart: session.assignmentStart,
      processedPromptIds: session.processedPromptIds,
    },
    live,
  );
  if (wrote) session.updatedAt = new Date().toISOString();
  return wrote;
}

export interface EndedLinearSession {
  /** True when this agent session owned a live or stored record. Cleanup of
   *  its worktree is only safe behind this flag. */
  owned: boolean;
  branch: string | null;
  /** True when the store record was removed (or was already absent). */
  removed: boolean;
  /** True when setup had not produced a worktree yet; the created flow owns
   *  cleanup once it learns the real path. */
  cleanupDeferred: boolean;
}

/**
 * End one agent session without touching any other session that reused its
 * issue or branch. The stored record is located by agent-session id, so an old
 * session's cleanup can never delete a replacement's file.
 */
export async function endLinearSession(
  linearSessionId: string,
  generatedBranch: string,
): Promise<EndedLinearSession> {
  const active = activeSessions.get(linearSessionId);
  if (active) {
    active.ended = true;
    if (!active.worktreeDir) active.cleanupCreatedWorktree = true;
    if (active.abortController) {
      active.abortController.abort();
      active.abortController = undefined;
    }
  }
  // Durable terminal state lands before the record/worktree disappear, so a
  // webhook replay after a restart cannot resurrect this id. A failed write is
  // an error: cleanup must not be silently reported as accepted.
  await markLinearSessionTerminal(linearSessionId);
  const stored = await findStoredSessionForAgentSession(
    linearSessionId,
    generatedBranch,
  );
  const key = active?.sessionKey ?? stored?.key;
  const branch = active?.branch ?? stored?.session.branch ?? null;
  const removed = key ? await deleteSessionFile(key, linearSessionId) : false;
  activeSessions.delete(linearSessionId);
  return {
    owned: !!active || !!stored,
    branch,
    removed,
    cleanupDeferred: !!active?.cleanupCreatedWorktree,
  };
}

/** Remove a checkout only when no other live session moved onto its branch. */
export async function deleteWorktreeIfUnused(
  branch: string,
  ownerLinearSessionId: string,
): Promise<boolean> {
  const inUse = [...activeSessions.entries()].some(
    ([id, session]) =>
      id !== ownerLinearSessionId &&
      !session.ended &&
      session.branch === branch,
  );
  if (inUse) return false;
  await removeWorktree(branch, defaultRepo().id);
  console.log(`[linear] Deleted worktree: ${branch}`);
  return true;
}

/**
 * The live session to drive for an issue: newest first, terminal records
 * excluded. `updatedAt` is maintained on every successful persist, so a new
 * assignment is never mistaken for the previous session on the same issue.
 */
export function latestSessionForIssue(
  issue: { id: string; identifier: string },
  sessions: Iterable<ActiveSession> = activeSessions.values(),
): ActiveSession | undefined {
  let best: ActiveSession | undefined;
  let bestAt = Number.NEGATIVE_INFINITY;
  for (const session of sessions) {
    if (session.ended) continue;
    if (
      session.issueId !== issue.id &&
      session.issueIdentifier !== issue.identifier
    )
      continue;
    const parsed = Date.parse(session.updatedAt || "");
    const updatedAt = Number.isFinite(parsed) ? parsed : 0;
    if (!best || updatedAt > bestAt) {
      best = session;
      bestAt = updatedAt;
    }
  }
  return best;
}

// --- Action activity streaming ---

/** Base URL of the Open Session web UI, linked from Linear sessions. */
export const OPENSESSION_UI_BASE =
  process.env.OPENSESSION_UI_BASE || configuredServer().publicBaseUrl;

export function opensessionSessionUrl(unifiedSessionId: string): string {
  return `${OPENSESSION_UI_BASE}/session/${encodeURIComponent(unifiedSessionId)}`;
}

/** Compact action row for a tool call: { action: "Read", parameter: "src/foo.ts" }. */
function summarizeAction(
  name: string,
  input: any,
): { action: string; parameter: string } {
  const inp = input || {};
  const mcp = name.match(/^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/);
  if (mcp) {
    return {
      action: mcp[1],
      parameter: `${mcp[2]} ${clip(JSON.stringify(inp))}`.trim(),
    };
  }
  switch (name) {
    case "Read":
    case "Edit":
    case "Write":
      return { action: name, parameter: inp.file_path || "" };
    case "Bash":
      return {
        action: "Ran",
        parameter: clip((inp.command || "").split("\n")[0]),
      };
    case "Grep":
      return {
        action: "Searched",
        parameter: clip(`${inp.pattern || ""} ${inp.path || inp.glob || ""}`),
      };
    case "Glob":
      return {
        action: "Globbed",
        parameter: clip(`${inp.pattern || ""} ${inp.path || ""}`),
      };
    case "Task":
    case "Agent":
      return {
        action: "Spawned agent",
        parameter: clip(inp.description || inp.subagent_type || ""),
      };
    case "WebFetch":
      return { action: "Fetched", parameter: clip(inp.url || "") };
    case "WebSearch":
      return { action: "Searched web", parameter: clip(inp.query || "") };
    case "Skill":
      return { action: "Skill", parameter: clip(inp.skill || "") };
    default:
      return { action: name, parameter: clip(JSON.stringify(inp)) };
  }
}

function clip(s: string, max = 120): string {
  return s.length > max ? s.slice(0, max) + "…" : s;
}

const ACTION_MIN_GAP_MS = 2000;

/**
 * Coalescing sender for action activities: tool bursts post at most one
 * activity per ACTION_MIN_GAP_MS (latest wins, trailing flush) so a busy run
 * doesn't flood the Linear timeline or the API. The full log stays in the
 * web UI; this is a progress feed.
 */
function makeActionStreamer(accessToken: string, linearSessionId: string) {
  let lastSent = 0;
  let pending: { action: string; parameter: string } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;

  const post = (a: { action: string; parameter: string }) => {
    createAgentActivity(accessToken, linearSessionId, {
      type: "action",
      ...a,
    }).catch((e) => console.error("[linear] Failed to send action:", e));
  };

  return {
    send(toolName: string, input: unknown) {
      const a = summarizeAction(toolName, input);
      const now = Date.now();
      if (now - lastSent >= ACTION_MIN_GAP_MS) {
        lastSent = now;
        post(a);
        return;
      }
      pending = a;
      if (!timer) {
        timer = setTimeout(
          () => {
            timer = null;
            if (pending) {
              lastSent = Date.now();
              post(pending);
              pending = null;
            }
          },
          ACTION_MIN_GAP_MS - (now - lastSent),
        );
      }
    },
    stop() {
      if (timer) clearTimeout(timer);
      timer = null;
      pending = null;
    },
  };
}

export interface LinearPromptEntry {
  id: string;
  text: string;
  timestamp: string;
}

// --- Headless agent runner (pi engine) ---

export async function runAgentHeadless(
  worktreeDir: string,
  prompt: string,
  linearSessionId: string,
  accessToken: string,
  resumeClaudeId?: string,
  session?: ActiveSession,
  promptEntry?: LinearPromptEntry,
): Promise<{ result: string; claudeSessionId: string }> {
  console.log(
    `[linear] Running agent in ${worktreeDir}${resumeClaudeId ? ` (resuming ${resumeClaudeId})` : ""}`,
  );

  // Attribute commits this run makes to the Linear issue creator.
  const commitAuthor = gitIdentityFor(session?.issueCreator?.email);

  // Kept as the loop's stop signal (linear/index.ts + handlers abort it):
  // aborting hard-cancels the engine run by its session id and exits the loop.
  const abortController = new AbortController();
  if (session) {
    session.abortController = abortController;
  }

  let result = "";
  let claudeSessionId = resumeClaudeId || "";
  let lastThoughtTime = 0;
  const THOUGHT_THROTTLE_MS = 5000;
  const actions = makeActionStreamer(accessToken, linearSessionId);

  // The issue actor (last prompting user, else the issue creator): gates
  // per-user `allowedUsers` MCP servers and drives the personal-first
  // subscription pick inside the engine. Account rotation and usage-limit
  // model fallback are runAgent's job now — no rotation loop here.
  const actorEmail =
    session?.lastActiveUser?.email || session?.issueCreator?.email || undefined;

  abortController.signal.addEventListener("abort", () => {
    void cancelAgentRun(claudeSessionId);
  });

  try {
    for await (const event of runAgent({
      // Interactive Linear sessions get the full connector set, as before.
      mcpServers: "all",
      prompt,
      sessionId: claudeSessionId || undefined,
      cwd: worktreeDir,
      mode: "code",
      ...(promptEntry
        ? {
            promptEntryId: promptEntry.id,
            promptEntryText: promptEntry.text,
            promptEntryTimestamp: promptEntry.timestamp,
          }
        : {}),
      model: toPiModel(session?.model || getDefaultModel()),
      user: actorEmail,
      author: commitAuthor,
      // Teammate-driven runs keep AWS read access — also keeps the shared
      // run environment identical across interactive kinds (a mixed
      // aws/non-aws env would drain-respawn the server on every alternation).
      aws: true,
      // Kind-only journal: gate marker for the pi engine, no crash
      // journal — this loop tracks its own engine session ids per Linear
      // session and re-drives turns from Linear events.
      journal: { kind: "linear" },
      // Transcript v2: key this run's store appends on the unified session id
      // the UI knows this session by. That id is derived from the store file
      // key (agent-session id for current sessions, branch for legacy files),
      // never from the branch, which a reassigned issue reuses. Map-only —
      // journal/resume/run-state semantics are untouched (see
      // RunAgentOpts.transcriptSessionId).
      transcriptSessionId: session
        ? linearUnifiedSessionId(session.sessionKey)
        : undefined,
      // Money-moving Stripe tools need the per-call human confirmation the
      // interactive runner provides; this path has no approval card, so they
      // are stripped from the tool list with this guidance.
      deniedTools: Object.fromEntries(
        Object.keys(STRIPE_CONFIRM_TOOLS).map((name) => [
          name,
          `This Stripe action requires human confirmation — open this session in ${productName()} and retry there; the approval card will appear in that UI.`,
        ]),
      ),
    })) {
      if (abortController.signal.aborted) break;

      if (event.type === "init") {
        claudeSessionId = event.sessionId || claudeSessionId;
      }

      // Stream tool calls (coalesced actions) and thoughts (throttled;
      // text_chunk carries whole completed text parts) to Linear.
      if (event.type === "tool_use" && event.toolName) {
        actions.send(event.toolName, event.toolInput);
      }
      if (event.type === "text_chunk" && event.text && event.text.length > 20) {
        const now = Date.now();
        if (now - lastThoughtTime > THOUGHT_THROTTLE_MS) {
          lastThoughtTime = now;
          createAgentActivity(accessToken, linearSessionId, {
            type: "thought",
            body: event.text.substring(0, 2000),
          }).catch((e) => console.error("[linear] Failed to send thought:", e));
        }
      }
      if (event.type === "model_switch") {
        const durable = shouldPersistModelSwitch(event);
        if (durable && event.toModel && session) session.model = event.toModel;
        createAgentActivity(accessToken, linearSessionId, {
          type: "thought",
          body: durable
            ? `${event.fromModel} is out of usage — continuing this turn on ${event.toModel}. Worktree state carries over.`
            : `${event.fromModel} ${event.switchReason || "fell back"} — using ${event.toModel} for this turn only. Worktree state carries over.`,
        }).catch(() => {});
      }

      if (event.type === "done") {
        claudeSessionId = event.sessionId || claudeSessionId;
        result = event.result || "";
        console.log(`[linear] Agent finished. Session ID: ${claudeSessionId}`);
      }
      if (event.type === "error") {
        result = `Error: ${event.content || "Unknown"}`;
      }
    }
  } catch (e: any) {
    if (!abortController.signal.aborted) {
      console.error(`[linear] agent run error:`, e);
      result = `Error: ${e.message || String(e)}`;
    }
  }

  if (session) {
    session.abortController = undefined;
  }
  actions.stop();
  return { result, claudeSessionId };
}

// --- PR creation ---

export async function createPrWithAttribution(
  worktreeDir: string,
  issueIdentifier: string,
  issueUrl: string,
  issueTitle: string,
  participants: Participant[],
  reviewer?: string | null,
): Promise<string | null> {
  let participantsLine = "";
  if (participants.length > 0) {
    const names = participants.map((p) => p.name).join(", ");
    participantsLine =
      participants.length === 1
        ? `**Requested by:** ${names} (via Linear)`
        : `**Participants:** ${names} (via Linear)`;
  }

  const prBody = `## Summary
Implements ${issueIdentifier}: ${issueTitle}

${issueUrl}
${participantsLine ? `\n${participantsLine}\n` : ""}
## Test plan
- [ ] Verify implementation meets acceptance criteria

🤖 Generated with [Claude Code](https://claude.com/claude-code)`;

  try {
    const repo = repoForPathOrNull(worktreeDir);
    if (!repo?.ghRepo || repo.host === "codestorage") {
      console.error(
        "[linear] Cannot create PR: worktree has no registered GitHub repository",
      );
      return null;
    }
    const credentialEnv = await githubServiceCredentialEnv(repo.ghRepo);
    if (!credentialEnv.GH_TOKEN) {
      console.error(
        `[linear] Cannot create PR: GitHub App credential unavailable for ${repo.ghRepo}`,
      );
      return null;
    }
    const args = [
      "gh",
      "pr",
      "create",
      "--title",
      `${issueIdentifier}: ${issueTitle}`,
      "--body",
      prBody,
    ];
    if (reviewer) {
      args.push("--reviewer", reviewer);
    }
    const proc = Bun.spawn(args, {
      cwd: worktreeDir,
      stdout: "pipe",
      stderr: "pipe",
      env: {
        ...process.env,
        ...credentialEnv,
        PATH: `${homeDir()}/.cargo/bin:${homeDir()}/.bun/bin:${homeDir()}/.local/bin:${homeDir()}/bin:${homeDir()}/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
        HOME: homeDir(),
      },
    });

    const output = await new Response(proc.stdout).text();
    const stderr = await new Response(proc.stderr).text();
    const exitCode = await proc.exited;

    if (exitCode !== 0) {
      console.error(`[linear] Failed to create PR: ${stderr}`);
      return null;
    }

    const urlMatch = output.match(/https:\/\/github\.com\/[^\s]+/);
    return urlMatch ? urlMatch[0] : output.trim();
  } catch (e) {
    console.error(`[linear] Error creating PR: ${e}`);
    return null;
  }
}

// --- Startup ---

export async function loadActiveSessionsOnStartup(
  tokens: LinearTokens,
): Promise<void> {
  console.log("[linear] Loading active sessions from catalog...");

  try {
    const sources = await completeAgentSessionCatalogSources("linear");

    // Single-workspace install: every session belongs to the one authorized org.
    const orgId = Object.keys(tokens)[0];
    if (!orgId) return;
    const accessToken = await getValidToken(orgId, tokens);
    if (!accessToken) return;

    let skippedStale = 0;
    for (const { file, data } of sources) {
      try {
        const sessionKey = agentSessionSourceKey(file);
        const stored = storedFromFile(sessionKey, data);

        if (
          stored &&
          stored.linearSessionId &&
          (stored.claudeSessionId || stored.phase === "awaiting_direction") &&
          !(await isLinearSessionTerminal(stored.linearSessionId))
        ) {
          // Don't resurrect long-idle sessions — a week without a run means the
          // ticket moved on without us; the file stays on disk for manual resume.
          const updatedAt = Date.parse(stored.updatedAt || "");
          if (!updatedAt || Date.now() - updatedAt > STALE_SESSION_MS) {
            skippedStale++;
            continue;
          }

          // Spreading the stored record hydrates every persisted field,
          // including any added later; only the run-time-only parts are
          // supplied here.
          const session: ActiveSession = {
            ...stored,
            sessionKey,
            accessToken,
            issueDescription: "",
            teamId: "",
            planningConversation: [],
          };

          activeSessions.set(stored.linearSessionId, session);

          console.log(
            `[linear] Restored session: ${stored.branch} from ${sessionKey} (Claude: ${stored.claudeSessionId}, Linear: ${stored.linearSessionId})`,
          );
        }
      } catch (e) {
        console.error(`[linear] Error loading session ${file}:`, e);
      }
    }
    if (skippedStale > 0) {
      console.log(
        `[linear] Skipped ${skippedStale} stale session file(s) (idle > 7 days)`,
      );
    }
  } catch (error) {
    console.error(
      "[linear] Session catalog unavailable; restoration deferred:",
      error,
    );
    throw error;
  }
}
