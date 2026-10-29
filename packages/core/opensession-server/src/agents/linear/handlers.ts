/**
 * Linear agent webhook handlers for AgentSession and Issue events.
 */
import { linearEmailToGithubUsername } from "../../server/shared/user-mappings";
import { defaultRepo, personaName } from "../../server/config";
import { fileSessionWorkspace } from "../../server/session-workspace";
import {
  createAgentActivity,
  fetchLinearUser,
  getIssueDetails,
  getIssueStatus,
  issueHasPlan,
  moveToStatus,
  postComment,
  updateAgentSession,
} from "./api";
import type { LinearTokens } from "./oauth";
import { getValidToken } from "./oauth";
import {
  PLANNING_PROMPT,
  IMPLEMENTATION_PROMPT,
  PLANNING_CONTINUATION_PROMPT,
  GREETING_PROMPT,
  MESSAGES,
} from "./prompts";
import {
  activeSessions,
  processedSessions,
  buildParticipantSections,
  createPrWithAttribution,
  createSessionWorktree,
  deleteWorktreeIfUnused,
  endLinearSession,
  findStoredSessionForAgentSession,
  formatConversationHistory,
  generateBranchName,
  latestSessionForIssue,
  linearSessionFileKey,
  linearUnifiedSessionId,
  loadSessionInfo,
  opensessionSessionUrl,
  persistActiveSession,
  runAgentHeadless,
  type ActiveSession,
  type LinearPromptEntry,
} from "./session";
import { isLinearSessionTerminal } from "./session-store";
import {
  clearLinearAssignmentStopped,
  isLinearAssignmentStopped,
  markLinearAssignmentStopped,
} from "./session-store";
import {
  appendLinearTranscript,
  linearGreetingEntry,
  linearUserEntry,
} from "./transcript";
import { linearStartMode, type LinearStartMode } from "./start-mode";

// --- Webhook types ---

export interface AgentSessionWebhook {
  action: "created" | "updated" | "ended" | "dismissed" | "prompted";
  type: "AgentSession";
  organizationId: string;
  actor?: { id: string; name: string };
  agentSession: {
    id: string;
    status: string;
    createdAt?: string;
    issue: {
      id: string;
      identifier: string;
      title: string;
      description?: string;
      url: string;
    };
    comments?: Array<{ id: string; body: string }>;
  };
  agentActivity?: {
    id?: string;
    createdAt?: string;
    signal?: string;
    userId?: string;
    content?: { type: string; body: string };
  };
}

export interface IssueWebhook {
  action: "create" | "update" | "remove";
  type: "Issue";
  organizationId: string;
  data: {
    id: string;
    identifier: string;
    title: string;
    description?: string;
    url: string;
    stateId?: string;
    assigneeId?: string;
  };
  updatedFrom?: {
    stateId?: string;
    assigneeId?: string;
  };
}

// In-flight guard for `prompted` webhooks, keyed by issue id. A redelivered or
// concurrent prompt would otherwise spawn a second query() resuming the SAME
// claudeSessionId in the same worktree — corrupting the turn. Parked on
// globalThis so a hot reload doesn't lose in-flight state.
const inFlightPrompts: Set<string> = ((
  globalThis as any
).__linearInFlightPrompts ??= new Set<string>());

// Agent-session ids already ended in this process. A delayed `created`
// delivery for one of them must not mint a worktree or record after cleanup.
const endedAgentSessions: Map<string, number> = ((
  globalThis as any
).__linearEndedAgentSessions ??= new Map<string, number>());
const ENDED_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

function isEndedAgentSession(id: string): boolean {
  const at = endedAgentSessions.get(id);
  if (at === undefined) return false;
  if (Date.now() - at > ENDED_SESSION_TTL_MS) {
    endedAgentSessions.delete(id);
    return false;
  }
  return true;
}

// Per-issue serialization for worktree creation. Branch names are generated
// from title + identifier, so two concurrent `created` deliveries for one
// issue would otherwise resolve the same branch.
const issueCreationChains: Map<string, Promise<unknown>> = ((
  globalThis as any
).__linearIssueCreationChains ??= new Map<string, Promise<unknown>>());

const sessionSetupRuns: Map<string, Promise<boolean>> = ((
  globalThis as any
).__linearSessionSetupRuns ??= new Map<string, Promise<boolean>>());

async function withIssueCreationLock<T>(
  issueId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = issueCreationChains.get(issueId) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  const queued = next.then(
    () => {},
    () => {},
  );
  issueCreationChains.set(issueId, queued);
  try {
    return await next;
  } finally {
    if (issueCreationChains.get(issueId) === queued) {
      issueCreationChains.delete(issueId);
    }
  }
}

function linearCreatorName(
  creator: { name: string; email: string | null } | null,
): string {
  const login = linearEmailToGithubUsername(creator?.email ?? null);
  return creator?.name || login || "Anonymous";
}

/**
 * Finish the durable, idempotent parts of a Linear session setup: workspace
 * filing, transcript greeting and the Linear greeting activity. One run per
 * agent session: parallel duplicate deliveries share it, so only one can post
 * the greeting.
 */
function completeLinearSessionSetup(
  session: ActiveSession,
  accessToken: string,
  issue: { identifier: string; title: string },
): Promise<boolean> {
  const id = session.linearSessionId;
  const inflight = sessionSetupRuns.get(id);
  if (inflight) return inflight;
  const run = runLinearSessionSetup(session, accessToken, issue).finally(() => {
    if (sessionSetupRuns.get(id) === run) sessionSetupRuns.delete(id);
  });
  sessionSetupRuns.set(id, run);
  return run;
}

async function runLinearSessionSetup(
  session: ActiveSession,
  accessToken: string,
  issue: { identifier: string; title: string },
): Promise<boolean> {
  const id = session.linearSessionId;
  const live = () => !session.ended && activeSessions.get(id) === session;
  if (!live() || (await isLinearSessionTerminal(id))) return false;

  const unifiedId = linearUnifiedSessionId(session.sessionKey);
  const mode = session.startMode ?? "ask";
  const greeting = GREETING_PROMPT.replaceAll(
    "$ISSUE_ID",
    issue.identifier,
  ).replaceAll("$ISSUE_TITLE", issue.title);
  let changed = false;

  if (!session.workspaceId) {
    const workspace = await fileSessionWorkspace({
      sessionId: unifiedId,
      repo: session.repoId ?? defaultRepo().id,
      branch: session.branch,
      worktreeDir: session.worktreeDir,
      ownsWorktree: session.ownsWorktree ?? false,
      title: `${issue.identifier}: ${issue.title}`,
      createdBy: linearCreatorName(session.issueCreator),
      createdAt: session.greetingAt,
      isLive: live,
    });
    if (!workspace) {
      if (!live() || (await isLinearSessionTerminal(id))) return false;
      throw new Error(`Workspace filing unavailable for ${id}`);
    }
    session.workspaceId = workspace.id;
    changed = true;
  }

  if (!live() || (await isLinearSessionTerminal(id))) return false;

  if (!session.greetingPostedAt) {
    if (mode === "ask") {
      const appended = await appendLinearTranscript(
        unifiedId,
        linearGreetingEntry({
          agentSessionId: session.linearSessionId,
          text: greeting,
          timestamp:
            session.greetingAt ?? session.updatedAt ?? new Date().toISOString(),
        }),
      );
      if (!appended) throw new Error(`Transcript unavailable for ${id}`);
      if (!live() || (await isLinearSessionTerminal(id))) return false;
    }
    const linked = await updateAgentSession(accessToken, id, {
      addedExternalUrls: [
        {
          url: opensessionSessionUrl(unifiedId),
          label: `Open in ${personaName()}`,
        },
      ],
    });
    if (!linked) throw new Error(`External link unavailable for ${id}`);
    if (!live() || (await isLinearSessionTerminal(id))) return false;
    if (mode === "ask") {
      await createAgentActivity(accessToken, id, {
        type: "elicitation",
        body: greeting,
      });
    }
    session.greetingPostedAt = new Date().toISOString();
    changed = true;
  }

  if (changed && !(await persistActiveSession(session))) {
    if (!live() || (await isLinearSessionTerminal(id))) return false;
    throw new Error(`Setup state unavailable for ${id}`);
  }
  return changed;
}

// --- Shared turn execution ---

interface LinearTurnOptions {
  promptEntry?: LinearPromptEntry;
  onClaimed?: (guard: LinearTurnGuard) => Promise<void>;
  onSettled?: (result: LinearTurnResult) => Promise<void>;
  reportGeneric?: boolean;
  /** Return once the claim and pre-run side effects land; completion runs in
   *  the background so a webhook can acknowledge without waiting for a model. */
  detachAfterClaim?: boolean;
}

interface LinearTurnGuard {
  cancelled: () => Promise<boolean>;
}

interface LinearTurnResult {
  busy: boolean;
  cancelled?: boolean;
  dispatched?: boolean;
  result?: string;
  error?: unknown;
}

/**
 * The one place a Linear turn is claimed, run, persisted and reported. Prompt
 * replies, issue-status auto-implementation and the assignment starter all use
 * it, so the per-issue in-flight guard, stop/end fence and result handling are
 * identical.
 */
async function executeLinearTurn(
  session: ActiveSession,
  accessToken: string,
  prompt: string,
  options: LinearTurnOptions = {},
): Promise<LinearTurnResult> {
  const issueId = session.issueId;
  const id = session.linearSessionId;
  if (inFlightPrompts.has(issueId)) return { busy: true };
  inFlightPrompts.add(issueId);

  const guard: LinearTurnGuard = {
    cancelled: async () =>
      !!session.stopRequested ||
      !!session.ended ||
      activeSessions.get(id) !== session ||
      (await isLinearSessionTerminal(id)),
  };

  let detached = false;
  try {
    if (await guard.cancelled()) return { busy: false, cancelled: true };
    await options.onClaimed?.(guard);
    if (await guard.cancelled()) return { busy: false, cancelled: true };

    if (options.detachAfterClaim) {
      detached = true;
      void runClaimedLinearTurn(
        session,
        accessToken,
        prompt,
        options,
        guard,
      ).finally(() => inFlightPrompts.delete(issueId));
      return { busy: false, dispatched: true };
    }
    return await runClaimedLinearTurn(
      session,
      accessToken,
      prompt,
      options,
      guard,
    );
  } catch (e) {
    console.error(`[linear] Error running Claude for prompt:`, e);
    await createAgentActivity(accessToken, id, {
      type: "error",
      body: `${e}`,
    }).catch(() => {});
    return { busy: false, error: e };
  } finally {
    if (!detached) inFlightPrompts.delete(issueId);
  }
}

async function runClaimedLinearTurn(
  session: ActiveSession,
  accessToken: string,
  prompt: string,
  options: LinearTurnOptions,
  guard: LinearTurnGuard,
): Promise<LinearTurnResult> {
  const id = session.linearSessionId;
  let outcome: LinearTurnResult;
  try {
    const { result, claudeSessionId } = await runAgentHeadless(
      session.worktreeDir,
      prompt,
      id,
      accessToken,
      session.claudeSessionId || undefined,
      session,
      options.promptEntry,
    );
    session.claudeSessionId = claudeSessionId;

    if (await guard.cancelled()) outcome = { busy: false, cancelled: true };
    else if (!(await persistActiveSession(session)))
      outcome = { busy: false, cancelled: true };
    else {
      if (result) {
        if (
          result.includes("PLANNING_COMPLETE") &&
          session.phase === "planning"
        ) {
          const planMatch = result.split("PLANNING_COMPLETE")[0].trim();
          if (planMatch) {
            await postComment(
              accessToken,
              session.issueId,
              `# Implementation Plan\n\n${planMatch}`,
            );
          }

          await moveToStatus(
            accessToken,
            session.issueId,
            session.teamId,
            "Ready",
          );
          session.planningConversation = [];
          session.phase = "awaiting_implementation";

          if (!(await persistActiveSession(session)))
            outcome = { busy: false, cancelled: true };
          else {
            await createAgentActivity(accessToken, id, {
              type: "elicitation",
              body: `${MESSAGES.planningComplete}\n\nReply when you're ready and I'll start implementing.`,
            });
            outcome = { busy: false, result };
          }
        } else if (result.includes("IMPLEMENTATION_COMPLETE")) {
          const creatorGithub = linearEmailToGithubUsername(
            session.issueCreator?.email || null,
          );
          const prUrl = await createPrWithAttribution(
            session.worktreeDir,
            session.issueIdentifier,
            session.issueUrl,
            session.issueTitle,
            session.participants || [],
            creatorGithub,
          );

          await createAgentActivity(accessToken, id, {
            type: "response",
            body: prUrl
              ? `Implementation complete! PR: ${prUrl}`
              : "Implementation complete! PR creation may have failed - please check manually.",
          });
          outcome = { busy: false, result };
        } else if (options.reportGeneric !== false) {
          if (session.phase === "planning") {
            session.planningConversation.push({
              role: "agent",
              content: result,
              timestamp: new Date().toISOString(),
            });
          }
          const type =
            session.phase === "planning"
              ? "elicitation"
              : result.startsWith("Error:")
                ? "error"
                : "response";
          await createAgentActivity(accessToken, id, { type, body: result });
          outcome = { busy: false, result };
        } else outcome = { busy: false, result };
      } else outcome = { busy: false, result };
    }
  } catch (e) {
    console.error(`[linear] Error running Claude for prompt:`, e);
    await createAgentActivity(accessToken, id, {
      type: "error",
      body: `${e}`,
    }).catch(() => {});
    outcome = { busy: false, error: e };
  }

  if (options.onSettled) {
    await options.onSettled(outcome).catch((e) => {
      console.error(`[linear] Failed to persist turn outcome for ${id}:`, e);
    });
  }
  return outcome;
}

// --- Assignment autostart ---

function assignmentPrompt(session: ActiveSession, mode: "plan" | "implement") {
  if (mode === "plan") {
    return PLANNING_PROMPT.replaceAll("$ISSUE_ID", session.issueIdentifier)
      .replaceAll("$ISSUE_URL", session.issueUrl)
      .replaceAll("$ISSUE_TITLE", session.issueTitle)
      .replaceAll(
        "$ISSUE_DESCRIPTION",
        session.issueDescription || "(No description)",
      );
  }
  const { participantsSection, coAuthorInstruction } = buildParticipantSections(
    session.participants || [],
    session.lastActiveUser || null,
  );
  return IMPLEMENTATION_PROMPT.replaceAll("$ISSUE_ID", session.issueIdentifier)
    .replaceAll("$ISSUE_URL", session.issueUrl)
    .replaceAll("$ISSUE_TITLE", session.issueTitle)
    .replaceAll(
      "$ISSUE_DESCRIPTION",
      session.issueDescription || "(No description)",
    )
    .replaceAll("$PARTICIPANTS_SECTION", participantsSection)
    .replaceAll("$CO_AUTHOR_INSTRUCTION", coAuthorInstruction);
}

/**
 * Start the one automatic turn an assignment asks for. The claim is written
 * before the runner and is never cleared by a retry: an uncertain pending or
 * dispatched claim is reported as needing attention instead of running twice.
 */
async function startAssignmentIfNeeded(
  session: ActiveSession,
  accessToken: string,
): Promise<"started" | "busy" | "claimed" | "cancelled" | "skipped"> {
  const mode = session.startMode ?? "ask";
  if (mode === "ask") return "skipped";
  if (await isLinearAssignmentStopped(session.linearSessionId))
    return "skipped";

  if (inFlightPrompts.has(session.issueId)) return "busy";

  const existing = session.assignmentStart;
  if (existing) {
    if (existing.status === "pending" || existing.status === "dispatched") {
      if (!existing.noticeAt) {
        existing.noticeAt = new Date().toISOString();
        await persistActiveSession(session);
        await createAgentActivity(accessToken, session.linearSessionId, {
          type: "response",
          body: "The automatic start was interrupted before this turn completed. Open the session to review it, then send a message when you want to continue.",
        }).catch(() => {});
      }
      return "claimed";
    }
    return "skipped";
  }

  const prompt = assignmentPrompt(session, mode);
  const promptEntry = {
    id: `linear-assignment:${session.linearSessionId}:${mode}`,
    text:
      mode === "plan"
        ? `Start planning for ${session.issueIdentifier}`
        : `Start implementation for ${session.issueIdentifier}`,
    timestamp: session.greetingAt ?? new Date().toISOString(),
  };
  const turn = await executeLinearTurn(session, accessToken, prompt, {
    reportGeneric: true,
    detachAfterClaim: true,
    promptEntry,
    onClaimed: async (guard) => {
      session.assignmentStart = {
        mode,
        status: "pending",
        claimedAt: new Date().toISOString(),
      };
      if (!(await persistActiveSession(session)))
        throw new Error("Assignment claim was not persisted");
      if (await guard.cancelled()) return;

      session.phase = mode === "plan" ? "planning" : "working";
      if (mode === "implement") {
        await moveToStatus(
          accessToken,
          session.issueId,
          session.teamId,
          "In Progress",
        );
        if (await guard.cancelled()) return;
      }
      await createAgentActivity(accessToken, session.linearSessionId, {
        type: "thought",
        body:
          mode === "plan"
            ? "Starting planning interview..."
            : MESSAGES.implementationStarted,
      });
      if (await guard.cancelled()) return;

      session.assignmentStart.status = "dispatched";
      if (!(await persistActiveSession(session)))
        throw new Error("Assignment dispatch was not persisted");
    },
    onSettled: async (result) => {
      if (!session.assignmentStart) return;
      session.assignmentStart.status = result.cancelled
        ? "cancelled"
        : result.error || result.result?.startsWith("Error:")
          ? "failed"
          : "completed";
      session.assignmentStart.settledAt = new Date().toISOString();
      await persistActiveSession(session);
    },
  });

  if (turn.busy) return "busy";
  if (turn.cancelled) {
    if (session.assignmentStart) {
      session.assignmentStart.status = "cancelled";
      session.assignmentStart.settledAt = new Date().toISOString();
      await persistActiveSession(session);
    }
    return "cancelled";
  }
  return "started";
}

// --- Issue status change → auto-implement ---

export async function handleIssueUpdate(
  webhook: IssueWebhook,
  tokens: LinearTokens,
): Promise<Response> {
  const { data: issue, organizationId, updatedFrom } = webhook;

  if (webhook.action !== "update") {
    return Response.json({ ok: true });
  }

  if (!updatedFrom?.stateId) {
    return Response.json({ ok: true });
  }

  const accessToken = await getValidToken(organizationId, tokens);
  if (!accessToken) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  const details = await getIssueDetails(accessToken, issue.id);
  console.log(
    `[linear] Issue ${issue.identifier} status changed to: ${details.status}`,
  );

  if (details.status.toLowerCase() !== "in progress") {
    return Response.json({ ok: true });
  }

  // Check for existing session. When a reassigned issue has more than one live
  // record (old and new agent session), drive the newest one; terminal records
  // are never resumed.
  let existingSession = latestSessionForIssue(issue);

  if (!existingSession) {
    const branch = generateBranchName(details.title, issue.identifier);
    const diskSession = await loadSessionInfo(branch);
    // A legacy branch-named file is adopted only when it records a Linear
    // agent-session id and has no terminal marker. A file without an id, with
    // another id, or one already ended is not this issue's current session.
    if (
      diskSession?.linearSessionId &&
      diskSession.claudeSessionId &&
      !(await isLinearSessionTerminal(diskSession.linearSessionId))
    ) {
      existingSession = {
        ...diskSession,
        sessionKey: branch,
        accessToken,
        issueTitle: details.title,
        issueIdentifier: issue.identifier,
        issueId: issue.id,
        issueDescription: details.description,
        issueUrl: details.url,
        teamId: details.teamId,
        planningConversation: [],
        // The ticket is in progress, so direction was given long ago; only a
        // pending implementation confirmation survives the hydrate.
        phase:
          diskSession.phase === "awaiting_implementation"
            ? "awaiting_implementation"
            : "working",
        issueCreator: diskSession.issueCreator || details.creator || null,
      };
      activeSessions.set(diskSession.linearSessionId, existingSession);
    }
  }

  if (
    existingSession &&
    (await isLinearSessionTerminal(existingSession.linearSessionId))
  ) {
    activeSessions.delete(existingSession.linearSessionId);
    existingSession = undefined;
  }

  if (!existingSession) {
    return Response.json({ ok: true });
  }

  if (await isLinearAssignmentStopped(existingSession.linearSessionId))
    return Response.json({ ok: true });
  if (
    existingSession.assignmentStart?.status === "pending" ||
    existingSession.assignmentStart?.status === "dispatched"
  )
    return Response.json({ ok: true });

  const hasPlan = await issueHasPlan(accessToken, issue.id);
  if (!hasPlan) {
    return Response.json({ ok: true });
  }

  console.log(
    `[linear] Auto-implementing ${issue.identifier} - has plan and moved to In Progress`,
  );

  if (existingSession.claudeSessionId) {
    existingSession.phase = "working";

    const { participantsSection, coAuthorInstruction } =
      buildParticipantSections(
        existingSession.participants || [],
        existingSession.lastActiveUser || null,
      );
    const implementationPrompt = IMPLEMENTATION_PROMPT.replaceAll(
      "$ISSUE_ID",
      issue.identifier,
    )
      .replaceAll("$ISSUE_URL", details.url)
      .replaceAll("$ISSUE_TITLE", details.title)
      .replaceAll("$ISSUE_DESCRIPTION", details.description)
      .replaceAll("$PARTICIPANTS_SECTION", participantsSection)
      .replaceAll("$CO_AUTHOR_INSTRUCTION", coAuthorInstruction);

    (async () => {
      try {
        await createAgentActivity(
          accessToken,
          existingSession!.linearSessionId,
          {
            type: "thought",
            body: `Auto-starting implementation (ticket moved to In Progress)`,
          },
        );
        await executeLinearTurn(
          existingSession!,
          accessToken,
          implementationPrompt,
          { reportGeneric: false },
        );
      } catch (e) {
        console.error(
          `[linear] Error auto-implementing ${issue.identifier}:`,
          e,
        );
      }
    })();
  }

  return Response.json({ ok: true, autoImplementing: true });
}

// --- Agent session webhook ---

export async function handleAgentSession(
  webhook: AgentSessionWebhook,
  tokens: LinearTokens,
): Promise<Response> {
  const { agentSession, organizationId, action } = webhook;

  // Stop signal
  if (action === "prompted" && webhook.agentActivity?.signal === "stop") {
    console.log(
      `[linear] Stop signal for issue: ${agentSession.issue.identifier}`,
    );
    const session = activeSessions.get(agentSession.id);
    try {
      await markLinearAssignmentStopped(agentSession.id);
    } catch (e) {
      console.error(`[linear] Could not record stop ${agentSession.id}:`, e);
      return Response.json({ error: "Stop not recorded" }, { status: 500 });
    }
    if (session) {
      session.stopRequested = true;
      if (!session.abortController && session.assignmentStart) {
        const status = session.assignmentStart.status;
        if (status === "pending" || status === "dispatched") {
          session.assignmentStart.status = "cancelled";
          session.assignmentStart.settledAt = new Date().toISOString();
          await persistActiveSession(session);
        }
      }
      if (session.abortController) {
        session.abortController.abort();
        session.abortController = undefined;
      }
    }
    return Response.json({ ok: true });
  }

  // Prompted — user sends message
  if (action === "prompted" && webhook.agentActivity?.content?.body) {
    const prompt = webhook.agentActivity.content.body;
    console.log(`[linear] Prompt from Linear: ${prompt.substring(0, 50)}...`);

    if (await isLinearSessionTerminal(agentSession.id)) {
      console.log(
        `[linear] Ignoring prompt for ended agent session ${agentSession.id}`,
      );
      return Response.json({ ok: true, ended: true });
    }

    let session = activeSessions.get(agentSession.id);
    if (session?.ended) {
      activeSessions.delete(agentSession.id);
      session = undefined;
    }

    // Recover from disk. The record must belong to THIS agent session: a
    // branch match alone is not enough, because a reassigned issue generates
    // the same branch and the previous session's transcript must not be
    // resumed under the new id.
    if (!session) {
      const branch = generateBranchName(
        agentSession.issue.title,
        agentSession.issue.identifier,
      );
      const stored = await findStoredSessionForAgentSession(
        agentSession.id,
        branch,
      );
      if (stored && !(await isLinearSessionTerminal(agentSession.id))) {
        const unifiedId = linearUnifiedSessionId(stored.key);
        console.log(
          `[linear] Recovered session ${stored.key} for agent session ${agentSession.id}`,
        );
        // Older sessions may predate external links — idempotent by url
        getValidToken(organizationId, tokens)
          .then((t) => {
            if (t) {
              updateAgentSession(t, agentSession.id, {
                addedExternalUrls: [
                  {
                    url: opensessionSessionUrl(unifiedId),
                    label: `Open in ${personaName()}`,
                  },
                ],
              }).catch(() => {});
            }
          })
          .catch(() => {});
        session = {
          ...stored.session,
          sessionKey: stored.key,
          accessToken: "",
          issueTitle: agentSession.issue.title,
          issueId: agentSession.issue.id,
          issueDescription: agentSession.issue.description || "",
          issueUrl: agentSession.issue.url,
          teamId: "",
          planningConversation: [],
        };
        activeSessions.set(agentSession.id, session);
      } else {
        console.log(
          `[linear] No owned session record for ${agentSession.id} (branch ${branch}); not reusing another agent session`,
        );
      }
    }

    if (session) {
      if (await isLinearAssignmentStopped(agentSession.id)) {
        await clearLinearAssignmentStopped(agentSession.id);
        if (
          (session.startMode === "plan" || session.startMode === "implement") &&
          !session.assignmentStart
        ) {
          session.assignmentStart = {
            mode: session.startMode,
            status: "cancelled",
            claimedAt: new Date().toISOString(),
            settledAt: new Date().toISOString(),
          };
          await persistActiveSession(session);
        }
      }
      // A `created` webhook registers its session before the (slow) worktree
      // setup finishes. Wait for the real path instead of running in a guess.
      if (session.ready) await session.ready.catch(() => {});
      if (!session.worktreeDir) {
        const token = await getValidToken(organizationId, tokens);
        if (token) {
          await createAgentActivity(token, agentSession.id, {
            type: "error",
            body: `This session could not be prepared. Reassign the issue to retry.`,
          }).catch(() => {});
        }
        return Response.json({ ok: true, unavailable: true });
      }
      if (!session.participants) session.participants = [];

      const accessToken = await getValidToken(organizationId, tokens);
      if (accessToken) {
        session.accessToken = accessToken;

        if (!session.teamId) {
          const { teamId } = await getIssueStatus(accessToken, session.issueId);
          session.teamId = teamId;
        }

        // Track participant
        const promptUserId = webhook.agentActivity?.userId;
        if (promptUserId) {
          const existingIdx = session.participants.findIndex(
            (p) => p.id === promptUserId,
          );
          if (existingIdx === -1) {
            const userParticipant = await fetchLinearUser(
              accessToken,
              promptUserId,
            );
            if (userParticipant) {
              session.participants.push(userParticipant);
              session.lastActiveUser = userParticipant;
            }
          } else {
            session.lastActiveUser = session.participants[existingIdx];
          }
        }

        let effectivePrompt = prompt;

        // Initial direction routing
        if (session.phase === "awaiting_direction") {
          const lowerPrompt = prompt.toLowerCase().trim();

          if (lowerPrompt.includes("plan")) {
            session.phase = "planning";
            effectivePrompt = PLANNING_PROMPT.replaceAll(
              "$ISSUE_ID",
              session.issueIdentifier,
            )
              .replaceAll("$ISSUE_URL", session.issueUrl)
              .replaceAll("$ISSUE_TITLE", session.issueTitle)
              .replaceAll(
                "$ISSUE_DESCRIPTION",
                session.issueDescription || "(No description)",
              );

            await createAgentActivity(accessToken, agentSession.id, {
              type: "thought",
              body: "Starting planning interview...",
            });
          } else if (lowerPrompt.includes("implement")) {
            session.phase = "working";
            await moveToStatus(
              accessToken,
              session.issueId,
              session.teamId,
              "In Progress",
            );

            const { participantsSection, coAuthorInstruction } =
              buildParticipantSections(
                session.participants || [],
                session.lastActiveUser || null,
              );
            effectivePrompt = IMPLEMENTATION_PROMPT.replaceAll(
              "$ISSUE_ID",
              session.issueIdentifier,
            )
              .replaceAll("$ISSUE_URL", session.issueUrl)
              .replaceAll("$ISSUE_TITLE", session.issueTitle)
              .replaceAll(
                "$ISSUE_DESCRIPTION",
                session.issueDescription || "(No description)",
              )
              .replaceAll("$PARTICIPANTS_SECTION", participantsSection)
              .replaceAll("$CO_AUTHOR_INSTRUCTION", coAuthorInstruction);

            await createAgentActivity(accessToken, agentSession.id, {
              type: "thought",
              body: MESSAGES.implementationStarted,
            });
          } else {
            session.phase = "working";
            effectivePrompt = `You are ${personaName()}, working on Linear ticket ${session.issueIdentifier} (${session.issueUrl}).

**Title:** ${session.issueTitle}
**Description:** ${session.issueDescription}

The user said: "${prompt}"

Help with whatever they're asking. You have a worktree ready at ${session.worktreeDir}.`;
          }
        }

        // Implementation confirmation
        else if (session.phase === "awaiting_implementation") {
          session.phase = "working";
          const { participantsSection, coAuthorInstruction } =
            buildParticipantSections(
              session.participants || [],
              session.lastActiveUser || null,
            );
          effectivePrompt = IMPLEMENTATION_PROMPT.replaceAll(
            "$ISSUE_ID",
            session.issueIdentifier,
          )
            .replaceAll("$ISSUE_URL", session.issueUrl)
            .replaceAll("$ISSUE_TITLE", session.issueTitle)
            .replaceAll("$ISSUE_DESCRIPTION", session.issueDescription)
            .replaceAll("$PARTICIPANTS_SECTION", participantsSection)
            .replaceAll("$CO_AUTHOR_INSTRUCTION", coAuthorInstruction);

          await moveToStatus(
            accessToken,
            session.issueId,
            session.teamId,
            "In Progress",
          );
          await createAgentActivity(accessToken, agentSession.id, {
            type: "thought",
            body: MESSAGES.implementationStarted,
          });
        }

        // Planning continuation
        if (
          session.phase === "planning" &&
          session.planningConversation.length > 0
        ) {
          session.planningConversation.push({
            role: "user",
            content: prompt,
            timestamp: new Date().toISOString(),
          });
          effectivePrompt = PLANNING_CONTINUATION_PROMPT.replaceAll(
            "$ISSUE_ID",
            session.issueIdentifier,
          )
            .replaceAll(
              "$CONVERSATION_HISTORY",
              formatConversationHistory(
                session.planningConversation.slice(0, -1),
              ),
            )
            .replaceAll("$LATEST_RESPONSE", prompt);
        }

        // Run Claude in background — at most one run per issue. Check-and-set
        // is synchronous, so two concurrent/redelivered prompts can't both
        // start a query() resuming the same claudeSessionId in this worktree.
        const s = session;
        const issueId = agentSession.issue.id;
        if (inFlightPrompts.has(issueId)) {
          console.log(
            `[linear] Refusing concurrent prompt for ${s.issueIdentifier} — a run is already in flight`,
          );
          await createAgentActivity(accessToken, agentSession.id, {
            type: "response",
            body: "I'm still working on the previous message for this issue — I can only run one turn at a time. Please wait for it to finish (or send a stop signal), then prompt me again.",
          }).catch(() => {});
          return Response.json({ ok: true, busy: true });
        }
        const activity = webhook.agentActivity;
        const promptTimestamp = activity?.createdAt ?? new Date().toISOString();
        const userEntry = linearUserEntry({
          agentSessionId: agentSession.id,
          activityId: activity?.id ?? null,
          text: prompt,
          timestamp: promptTimestamp,
          sourceTimestamp: activity?.createdAt ?? null,
          userId: activity?.userId ?? null,
        });
        const promptEntry = {
          id: userEntry.id,
          text: prompt,
          timestamp: promptTimestamp,
        };
        s.stopRequested = false;
        void executeLinearTurn(s, accessToken, effectivePrompt, {
          promptEntry,
          onClaimed: async () => {
            try {
              await appendLinearTranscript(
                linearUnifiedSessionId(s.sessionKey),
                userEntry,
              );
            } catch (e) {
              console.error(`[linear] Failed to append prompt transcript:`, e);
            }
          },
        });
      }
    } else {
      console.log(`[linear] No active session found for ${agentSession.id}`);
    }
    return Response.json({ ok: true });
  }

  // Dismissed/ended — cleanup only what THIS agent session owns
  if (action === "dismissed" || action === "ended") {
    console.log(
      `[linear] Session ${action} for issue: ${agentSession.issue.identifier}`,
    );
    endedAgentSessions.set(agentSession.id, Date.now());
    const branch = generateBranchName(
      agentSession.issue.title,
      agentSession.issue.identifier,
    );
    try {
      const ended = await endLinearSession(agentSession.id, branch);
      if (ended.removed && ended.branch && !ended.cleanupDeferred) {
        // Never remove a checkout another live agent session is using. New
        // assignments resolve a unique branch, so this only guards shared or
        // legacy sessions that still point at the same one.
        await deleteWorktreeIfUnused(ended.branch, agentSession.id);
      }
    } catch (e) {
      console.error(
        `[linear] Could not clean up session ${agentSession.id}:`,
        e,
      );
      return Response.json({ error: "Cleanup failed" }, { status: 500 });
    }
    return Response.json({ ok: true });
  }

  // Created — new session
  if (action !== "created") {
    return Response.json({ ok: true });
  }

  const sessionId = agentSession.id;
  const liveSession = activeSessions.get(sessionId);
  if (liveSession) {
    // A live session owns the worktree and abort controller. A redelivery may
    // only finish setup steps that failed earlier; it never replaces the
    // object or starts another run.
    if (liveSession.ready) {
      return Response.json({ ok: true, skipped: true });
    }
    const liveToken = await getValidToken(organizationId, tokens);
    if (!liveToken) {
      return Response.json({ error: "Not authorized" }, { status: 401 });
    }
    let finished = false;
    try {
      finished = await completeLinearSessionSetup(
        liveSession,
        liveToken,
        agentSession.issue,
      );
    } catch (e) {
      console.error(`[linear] Failed to finish setup ${sessionId}:`, e);
      return Response.json(
        { error: "Setup incomplete", retryable: true },
        { status: 503 },
      );
    }
    await startAssignmentIfNeeded(liveSession, liveToken).catch((e) => {
      console.error(`[linear] Assignment start failed ${sessionId}:`, e);
    });
    return Response.json(
      finished ? { ok: true, initialized: true } : { ok: true, skipped: true },
    );
  }
  if (processedSessions.has(sessionId)) {
    return Response.json({ ok: true, skipped: true });
  }
  if (isEndedAgentSession(sessionId)) {
    console.log(
      `[linear] Ignoring created event for already-ended session ${sessionId}`,
    );
    return Response.json({ ok: true, skipped: true });
  }
  if (await isLinearSessionTerminal(sessionId)) {
    endedAgentSessions.set(sessionId, Date.now());
    console.log(
      `[linear] Ignoring created event for durably ended session ${sessionId}`,
    );
    return Response.json({ ok: true, skipped: true });
  }
  // The terminal check yielded. Re-check and claim the intake synchronously:
  // two concurrent deliveries can both pass the checks above while this await
  // is pending, and only one may proceed to create a worktree.
  if (
    processedSessions.has(sessionId) ||
    isEndedAgentSession(sessionId) ||
    activeSessions.has(sessionId)
  ) {
    return Response.json({ ok: true, skipped: true });
  }
  processedSessions.add(sessionId);
  setTimeout(() => processedSessions.delete(sessionId), 5 * 60 * 1000);

  const accessToken = await getValidToken(organizationId, tokens);
  if (!accessToken) {
    return Response.json({ error: "Not authorized" }, { status: 401 });
  }

  const { issue } = agentSession;
  console.log(
    `[linear] New session for issue: ${issue.identifier} - ${issue.title}`,
  );

  const desiredBranch = generateBranchName(issue.title, issue.identifier);
  let sessionKey: string;
  try {
    sessionKey = linearSessionFileKey(sessionId);
  } catch (e) {
    console.error(
      `[linear] Rejecting invalid agent session id ${sessionId}:`,
      e,
    );
    return Response.json({ error: "Invalid session id" }, { status: 400 });
  }

  // Duplicate delivery after a restart: the agent-session-keyed record is the
  // idempotency marker. Reuse its worktree and identity instead of creating a
  // second session for the same Linear agent session.
  const existing = await findStoredSessionForAgentSession(
    sessionId,
    desiredBranch,
  );
  if (
    isEndedAgentSession(sessionId) ||
    activeSessions.has(sessionId) ||
    (await isLinearSessionTerminal(sessionId))
  ) {
    return Response.json({ ok: true, skipped: true });
  }
  if (existing?.session.worktreeDir) {
    const reused: ActiveSession = {
      ...existing.session,
      sessionKey: existing.key,
      accessToken,
      issueDescription: issue.description || "",
      teamId: "",
      // Disk records have one; a legacy record that omits it still needs a
      // freshness signal before another record can be picked as newest.
      updatedAt: existing.session.updatedAt || new Date().toISOString(),
      greetingAt: existing.session.greetingAt ?? new Date().toISOString(),
      startMode: existing.session.startMode ?? "ask",
      planningConversation: [],
    };
    activeSessions.set(sessionId, reused);
    try {
      await completeLinearSessionSetup(reused, accessToken, issue);
    } catch (e) {
      console.error(
        `[linear] Failed to finish reused setup ${existing.key}:`,
        e,
      );
      return Response.json(
        { error: "Setup incomplete", retryable: true },
        { status: 503 },
      );
    }
    await startAssignmentIfNeeded(reused, accessToken).catch((e) => {
      console.error(
        `[linear] Assignment start failed for reused ${existing.key}:`,
        e,
      );
    });
    console.log(
      `[linear] Reused existing session ${existing.key} for agent session ${sessionId}`,
    );
    return Response.json({
      ok: true,
      reused: true,
      branch: reused.branch,
    });
  }

  const { teamId } = await getIssueStatus(accessToken, issue.id);
  const issueDetails = await getIssueDetails(accessToken, issue.id);

  // An end can arrive while the Linear API calls above are in flight, before
  // this session is registered. Re-fence before any worktree is created.
  if (
    isEndedAgentSession(sessionId) ||
    activeSessions.has(sessionId) ||
    (await isLinearSessionTerminal(sessionId))
  ) {
    return Response.json({ ok: true, skipped: true });
  }

  let finishReady: () => void = () => {};
  const ready = new Promise<void>((resolve) => {
    finishReady = resolve;
  });

  const session: ActiveSession = {
    branch: desiredBranch,
    claudeSessionId: null,
    accessToken,
    issueTitle: issue.title,
    issueIdentifier: issue.identifier,
    issueId: issue.id,
    issueDescription: issue.description || "",
    issueUrl: issue.url,
    teamId,
    // Filled in from createSessionWorktree's real path before any run.
    worktreeDir: "",
    linearSessionId: sessionId,
    sessionKey,
    phase: "awaiting_direction",
    ready,
    updatedAt: new Date().toISOString(),
    greetingAt: agentSession.createdAt ?? new Date().toISOString(),
    startMode: linearStartMode(),
    planningConversation: [],
    participants: [],
    lastActiveUser: null,
    issueCreator: issueDetails.creator,
  };
  activeSessions.set(sessionId, session);

  (async () => {
    try {
      await createAgentActivity(accessToken, sessionId, {
        type: "thought",
        body: MESSAGES.starting,
      });

      const created = await withIssueCreationLock(issue.id, () =>
        createSessionWorktree(desiredBranch),
      );
      session.branch = created.branch;
      session.worktreeDir = created.worktreeDir;
      session.repoId = created.repoId;
      session.ownsWorktree = created.ownsWorktree;

      // Ended while the worktree was being created: endLinearSession could not
      // remove a path that did not exist yet. Clean it up now, before any
      // record or greeting, so a slow create cannot leak a checkout.
      const cleanupOwnCheckout = async () => {
        if (created.ownsWorktree)
          await deleteWorktreeIfUnused(created.branch, sessionId);
      };
      if (session.cleanupCreatedWorktree) {
        session.cleanupCreatedWorktree = false;
        await cleanupOwnCheckout();
        return;
      }
      if (session.ended || activeSessions.get(sessionId) !== session) return;

      if (!(await persistActiveSession(session))) {
        // An end can land after the API fence but before the session is
        // registered. The save refuses then; remove only the checkout this
        // create just made.
        await cleanupOwnCheckout();
        return;
      }
      if (
        session.ended ||
        activeSessions.get(sessionId) !== session ||
        (await isLinearSessionTerminal(sessionId))
      )
        return;

      try {
        await completeLinearSessionSetup(session, accessToken, issue);
      } catch (e) {
        // The session file and worktree are durable; a later duplicate created
        // retries workspace/transcript/greeting without minting a second run.
        console.error(`[linear] Failed to finish setup ${sessionId}:`, e);
        return;
      }
      await startAssignmentIfNeeded(session, accessToken).catch((e) => {
        console.error(`[linear] Assignment start failed ${sessionId}:`, e);
      });
    } catch (e) {
      // An ended session's setup failure is not worth an activity; cleanup ran
      // (or the created path above found no worktree to remove).
      if (session.ended || (await isLinearSessionTerminal(sessionId))) return;
      console.error(`[linear] Error in session creation:`, e);
      // Leave no empty session that would answer the next prompt.
      if (activeSessions.get(sessionId) === session)
        activeSessions.delete(sessionId);
      await createAgentActivity(accessToken, sessionId, {
        type: "error",
        body: `${MESSAGES.error} Failed to initialize: ${e}`,
      });
    } finally {
      session.ready = undefined;
      finishReady();
    }
  })();

  return Response.json({ ok: true, branch: desiredBranch });
}
