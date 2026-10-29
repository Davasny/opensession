/**
 * Regression tests for the branch-keyed Linear session collision.
 *
 * A Linear agent session's identity must be its Linear agent-session id, not
 * the branch generated from issue title + identifier. Reassigning the same
 * issue regenerates the branch; the new agent session must get its own store
 * file, worktree, transcript id and external link, and the previous session's
 * late saves or cleanup must never touch it.
 *
 * Everything here is synthetic: the Linear API, OAuth, the worktree layer and
 * the agent runner are replaced with in-memory doubles.
 */
import { afterEach, beforeEach, expect, mock, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const worktreeRoot = "/synthetic-worktrees";
const createdBranches: string[] = [];
const removedBranches: string[] = [];
const usedBranches = new Set<string>();
const runCalls: Array<Record<string, unknown>> = [];
const activityCalls: Array<{ sessionId: string; content: any }> = [];
const linkCalls: Array<{ sessionId: string; urls: string[] }> = [];
const workspaceCalls: Array<Record<string, unknown>> = [];
const transcriptCalls: Array<{ sessionId: string; entry: any }> = [];
let createGate: Promise<void> | null = null;
let runGate: Promise<void> | null = null;
let apiGate: Promise<void> | null = null;
let apiGateStarted: (() => void) | null = null;
let issueStatus = "Todo";
let issueHasPlanResult = false;
let workspaceFailures = 0;
let transcriptFailures = 0;
let transcriptUnavailable = false;
let elicitationGate: Promise<void> | null = null;
let elicitationStarted: (() => void) | null = null;

mock.module("../../server/worktree", () => ({
  createWorktree: async (branch: string) => {
    const gate = createGate;
    createGate = null;
    if (gate) await gate;
    createdBranches.push(branch);
    usedBranches.add(branch);
    return `${worktreeRoot}/${branch}`;
  },
  resolveUniqueBranch: async (desired: string) => {
    if (!usedBranches.has(desired)) return desired;
    for (let n = 2; n < 100; n++) {
      const candidate = `${desired}-${n}`;
      if (!usedBranches.has(candidate)) return candidate;
    }
    return desired;
  },
  sharedCheckoutForNewSessions: () => false,
  removeWorktree: async (branch: string) => {
    removedBranches.push(branch);
  },
}));

mock.module("./api", () => ({
  createAgentActivity: async (
    token: string,
    sessionId: string,
    content: any,
  ) => {
    activityCalls.push({ sessionId, content });
    if (content.type === "elicitation") {
      const gate = elicitationGate;
      elicitationGate = null;
      elicitationStarted?.();
      elicitationStarted = null;
      if (gate) await gate;
    }
  },
  updateAgentSession: async (
    token: string,
    sessionId: string,
    input: { addedExternalUrls?: Array<{ url: string }> },
  ) => {
    linkCalls.push({
      sessionId,
      urls: (input.addedExternalUrls || []).map((u) => u.url),
    });
    return true;
  },
  getIssueStatus: async () => ({ status: issueStatus, teamId: "team-1" }),
  getIssueDetails: async () => {
    const gate = apiGate;
    apiGate = null;
    apiGateStarted?.();
    apiGateStarted = null;
    if (gate) await gate;
    return {
      status: issueStatus,
      teamId: "team-1",
      title: "Fix the bug",
      description: "It is broken",
      url: "https://linear.app/example/issue/ENG-1",
      identifier: "ENG-1",
      creator: { id: "creator-1", name: "Ada", email: "ada@example.test" },
    };
  },
  issueHasPlan: async () => issueHasPlanResult,
  moveToStatus: async () => true,
  postComment: async () => true,
  fetchLinearUser: async () => null,
}));

mock.module("./oauth", () => ({
  getValidToken: async () => "synthetic-token",
}));

mock.module("../../server/agent-runner", () => ({
  cancelAgentRun: async () => {},
  runAgent: async function* (opts: Record<string, unknown>) {
    runCalls.push(opts);
    const gate = runGate;
    runGate = null;
    if (gate) await gate;
    yield { type: "init", sessionId: `engine-${String(opts.cwd)}` };
    yield {
      type: "done",
      sessionId: `engine-${String(opts.cwd)}`,
      result: "",
    };
  },
}));

// Persistence is under test; the list index / catalog projection is not.
mock.module("../../server/session-cache", () => ({
  publishSessionChange: async () => {},
}));

mock.module("../../server/session-workspace", () => ({
  fileSessionWorkspace: async (input: Record<string, unknown>) => {
    workspaceCalls.push(input);
    if (workspaceFailures > 0) {
      workspaceFailures--;
      throw new Error("synthetic workspace failure");
    }
    return {
      id: "ws-linear-test",
      name: String(input.title ?? "linear"),
      repo: input.repo,
      branch: input.branch,
      worktreeDir: input.worktreeDir,
      createdBy: input.createdBy,
    };
  },
}));

mock.module("./transcript", () => ({
  linearGreetingEntry: (input: {
    agentSessionId: string;
    text: string;
    timestamp: string;
  }) => ({
    id: `linear-greeting:${input.agentSessionId}`,
    type: "assistant",
    content: input.text,
    timestamp: input.timestamp,
  }),
  linearUserEntry: (input: {
    agentSessionId: string;
    activityId: string | null;
    text: string;
    timestamp: string;
  }) => ({
    id: `linear-activity:${input.activityId ?? input.agentSessionId}`,
    type: "user",
    content: input.text,
    timestamp: input.timestamp,
  }),
  appendLinearTranscript: async (sessionId: string, entry: any) => {
    transcriptCalls.push({ sessionId, entry });
    if (transcriptUnavailable) return null;
    if (transcriptFailures > 0) {
      transcriptFailures--;
      throw new Error("synthetic transcript failure");
    }
    return { firstSeq: 0, lastSeq: 0, inserted: 1, updated: 0 };
  },
}));

const { handleAgentSession, handleIssueUpdate } = await import("./handlers");
const {
  activeSessions,
  processedSessions,
  endLinearSession,
  latestSessionForIssue,
  linearSessionFileKey,
  linearUnifiedSessionId,
  loadSessionInfo,
  persistActiveSession,
  saveSessionInfo,
  deleteSessionFile,
} = await import("./session");
const { isLinearSessionTerminal, markLinearSessionTerminal } =
  await import("./session-store");

const HOME = process.env.HOME!;
const SESSION_DIR = join(HOME, ".linear-sessions");

const ISSUE = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Fix the bug",
  description: "It is broken",
  url: "https://linear.app/example/issue/ENG-1",
};
const BRANCH = "fix-the-eng1";

function webhook(
  action: "created" | "ended" | "dismissed" | "prompted",
  id: string,
  extra: Record<string, unknown> = {},
) {
  return {
    action,
    type: "AgentSession",
    organizationId: "org-1",
    agentSession: {
      id,
      status: "active",
      issue: { ...ISSUE },
    },
    ...extra,
  } as any;
}

function prompted(id: string, body = "go ahead") {
  return webhook("prompted", id, {
    agentActivity: {
      signal: "continue",
      userId: "user-1",
      content: { type: "prompt", body },
    },
  });
}

function storedPath(key: string) {
  return join(SESSION_DIR, `${key}.json`);
}

function readStored(key: string) {
  return JSON.parse(readFileSync(storedPath(key), "utf8"));
}

function writeStored(key: string, value: Record<string, unknown>) {
  mkdirSync(SESSION_DIR, { recursive: true });
  writeFileSync(storedPath(key), JSON.stringify(value));
}

async function awaitReady(id: string) {
  const session = activeSessions.get(id);
  if (session?.ready) await session.ready;
  await Bun.sleep(0);
}

async function waitFor(check: () => boolean, label: string) {
  for (let i = 0; i < 200; i++) {
    if (check()) return;
    await Bun.sleep(5);
  }
  throw new Error(`timed out waiting for ${label}`);
}

beforeEach(() => {
  activeSessions.clear();
  processedSessions.clear();
  (globalThis as any).__linearEndedAgentSessions?.clear();
  createdBranches.length = 0;
  removedBranches.length = 0;
  usedBranches.clear();
  runCalls.length = 0;
  activityCalls.length = 0;
  linkCalls.length = 0;
  workspaceCalls.length = 0;
  transcriptCalls.length = 0;
  createGate = null;
  runGate = null;
  apiGate = null;
  apiGateStarted = null;
  issueStatus = "Todo";
  issueHasPlanResult = false;
  workspaceFailures = 0;
  transcriptFailures = 0;
  transcriptUnavailable = false;
  elicitationGate = null;
  elicitationStarted = null;
  mkdirSync(SESSION_DIR, { recursive: true });
});

afterEach(() => {
  activeSessions.clear();
  processedSessions.clear();
  (globalThis as any).__linearEndedAgentSessions?.clear();
});

test("reassigning the same issue/title starts a new identity, file and worktree", async () => {
  const first = "11111111-1111-4111-8111-111111111111";
  const second = "22222222-2222-4222-8222-222222222222";
  const firstKey = linearSessionFileKey(first);
  const secondKey = linearSessionFileKey(second);

  await handleAgentSession(webhook("created", first), {});
  await awaitReady(first);

  expect(createdBranches).toEqual([BRANCH]);
  expect(readStored(firstKey)).toMatchObject({
    branch: BRANCH,
    linearSessionId: first,
    worktreeDir: `${worktreeRoot}/${BRANCH}`,
    workspaceId: "ws-linear-test",
  });
  expect(workspaceCalls).toHaveLength(1);
  expect(workspaceCalls[0]).toMatchObject({
    sessionId: linearUnifiedSessionId(firstKey),
    repo: "opensession",
    branch: BRANCH,
    worktreeDir: `${worktreeRoot}/${BRANCH}`,
    ownsWorktree: true,
    createdBy: "Ada",
  });
  expect(
    transcriptCalls.filter((call) => call.entry.type === "assistant"),
  ).toHaveLength(1);
  // The external link points at the new identity, not the branch.
  const firstUnified = linearUnifiedSessionId(firstKey);
  expect(
    linkCalls
      .at(-1)
      ?.urls.some((url) =>
        url.endsWith(`/session/${encodeURIComponent(firstUnified)}`),
      ),
  ).toBe(true);

  await handleAgentSession(webhook("ended", first), {});
  expect(existsSync(storedPath(firstKey))).toBe(false);
  expect(removedBranches).toEqual([BRANCH]);

  await handleAgentSession(webhook("created", second), {});
  await awaitReady(second);

  // The old branch exists in git after its worktree is removed, so the new
  // assignment gets a unique branch and its own checkout instead of failing or
  // reusing the old one.
  expect(createdBranches).toEqual([BRANCH, `${BRANCH}-2`]);
  expect(readStored(secondKey)).toMatchObject({
    branch: `${BRANCH}-2`,
    linearSessionId: second,
    worktreeDir: `${worktreeRoot}/${BRANCH}-2`,
    claudeSessionId: null,
  });
  expect(existsSync(storedPath(firstKey))).toBe(false);
  expect(activeSessions.get(second)?.worktreeDir).toBe(
    `${worktreeRoot}/${BRANCH}-2`,
  );
});

test("duplicate created for the same agent session is idempotent after a restart", async () => {
  const id = "33333333-3333-4333-8333-333333333333";
  const key = linearSessionFileKey(id);

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  expect(createdBranches).toEqual([BRANCH]);

  // Simulate a process restart: no in-memory dedup, only the store file.
  activeSessions.clear();
  processedSessions.clear();

  const response = await handleAgentSession(webhook("created", id), {});
  expect(await response.json()).toMatchObject({ reused: true, branch: BRANCH });

  expect(createdBranches).toEqual([BRANCH]);
  expect(existsSync(storedPath(key))).toBe(true);
  expect(activeSessions.get(id)?.worktreeDir).toBe(`${worktreeRoot}/${BRANCH}`);
  // Reuse relinks the viewer without minting another file or greeting.
  expect(
    activityCalls.filter((c) => c.content.type === "elicitation").length,
  ).toBe(1);
  expect(workspaceCalls).toHaveLength(1);
  expect(
    transcriptCalls.filter((call) => call.entry.type === "assistant"),
  ).toHaveLength(1);
});

test("prompted recovery refuses a branch record owned by another agent session", async () => {
  const previous = "44444444-4444-4444-8444-444444444444";
  const next = "55555555-5555-4555-8555-555555555555";
  writeStored(BRANCH, {
    branch: BRANCH,
    worktreeDir: `${worktreeRoot}/${BRANCH}`,
    claudeSessionId: "engine-previous",
    linearSessionId: previous,
    issueIdentifier: ISSUE.identifier,
    issueTitle: ISSUE.title,
    phase: "working",
    updatedAt: new Date().toISOString(),
  });
  activeSessions.clear();

  await handleAgentSession(prompted(next), {});
  await Bun.sleep(20);

  expect(activeSessions.has(next)).toBe(false);
  expect(runCalls).toEqual([]);
  // The previous session's record is untouched, and no branch-based link was
  // added for the new agent session.
  expect(readStored(BRANCH).linearSessionId).toBe(previous);
  expect(linkCalls.some((c) => c.sessionId === next)).toBe(false);
});

test("a legacy record whose id matches is recovered and keeps its legacy link", async () => {
  const id = "66666666-6666-4666-8666-666666666666";
  writeStored(BRANCH, {
    branch: BRANCH,
    worktreeDir: `${worktreeRoot}/legacy`,
    claudeSessionId: "engine-legacy",
    linearSessionId: id,
    issueIdentifier: ISSUE.identifier,
    issueTitle: ISSUE.title,
    phase: "working",
    updatedAt: new Date().toISOString(),
  });
  activeSessions.clear();

  await handleAgentSession(prompted(id), {});
  await waitFor(() => runCalls.length === 1, "legacy recovery run");

  expect(runCalls[0]).toMatchObject({
    cwd: `${worktreeRoot}/legacy`,
    sessionId: "engine-legacy",
    // Legacy rows keep the id and transcript they always had.
    transcriptSessionId: `linear-${BRANCH}`,
  });
  expect(activeSessions.get(id)?.sessionKey).toBe(BRANCH);
  expect(
    linkCalls
      .at(-1)
      ?.urls.some((url) =>
        url.endsWith(`/session/${encodeURIComponent(`linear-${BRANCH}`)}`),
      ),
  ).toBe(true);
});

test("prompted recovery by a known agent-session id uses that file and transcript id", async () => {
  const id = "77777777-7777-4777-8777-777777777777";
  const key = linearSessionFileKey(id);

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  const originalWorktree = activeSessions.get(id)!.worktreeDir;

  // Restart: only the id-keyed file remains.
  activeSessions.clear();
  processedSessions.clear();

  await handleAgentSession(prompted(id), {});
  await waitFor(() => runCalls.length === 1, "known-id recovery run");

  expect(runCalls[0]).toMatchObject({
    cwd: originalWorktree,
    transcriptSessionId: `linear-${key}`,
    promptEntryId: `linear-activity:${id}`,
    promptEntryText: "go ahead",
    promptEntryTimestamp: expect.any(String),
  });
  expect(
    transcriptCalls.some(
      (call) => call.entry.type === "user" && call.entry.content === "go ahead",
    ),
  ).toBe(true);
  expect(activeSessions.get(id)?.sessionKey).toBe(key);
});

test("an ended session's late save and late cleanup cannot touch its replacement", async () => {
  const first = "88888888-8888-4888-8888-888888888888";
  const second = "99999999-9999-4999-8999-999999999999";
  const firstKey = linearSessionFileKey(first);
  const secondKey = linearSessionFileKey(second);

  await handleAgentSession(webhook("created", first), {});
  await awaitReady(first);
  const oldSession = activeSessions.get(first)!;
  const firstBranch = oldSession.branch;

  await handleAgentSession(webhook("ended", first), {});
  expect(existsSync(storedPath(firstKey))).toBe(false);

  await handleAgentSession(webhook("created", second), {});
  await awaitReady(second);
  const replacement = readStored(secondKey);

  // The old run finishes after cleanup. It must not recreate its file or write
  // into the replacement's.
  oldSession.claudeSessionId = "engine-late";
  oldSession.phase = "working";
  expect(await persistActiveSession(oldSession)).toBe(false);
  expect(existsSync(storedPath(firstKey))).toBe(false);
  expect(readStored(secondKey)).toEqual(replacement);

  // A redelivered end for the old id finds no record and removes no worktree
  // that the replacement now owns.
  removedBranches.length = 0;
  await handleAgentSession(webhook("ended", first), {});
  await Bun.sleep(10);
  expect(removedBranches).toEqual([]);
  expect(existsSync(storedPath(secondKey))).toBe(true);
  expect(activeSessions.has(second)).toBe(true);
});

test("a terminal marker survives a restart and blocks created/prompt replay", async () => {
  const id = "cccccccc-cccc-4ccc-8ccc-cccccccccccc";

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  await handleAgentSession(webhook("ended", id), {});
  expect(await isLinearSessionTerminal(id)).toBe(true);

  // Simulate a restart: only the durable store and marker remain.
  activeSessions.clear();
  processedSessions.clear();
  (globalThis as any).__linearEndedAgentSessions?.clear();

  const replay = await handleAgentSession(webhook("created", id), {});
  expect(await replay.json()).toMatchObject({ skipped: true });
  expect(createdBranches).toEqual([BRANCH]);

  const prompt = await handleAgentSession(prompted(id), {});
  expect(await prompt.json()).toMatchObject({ ended: true });
  expect(runCalls).toEqual([]);
  expect(activeSessions.has(id)).toBe(false);
});

test("a terminal marker write failure is not reported as a successful end", async () => {
  const id = "abababab-abab-4bab-8bab-abababababac";
  const key = linearSessionFileKey(id);

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  // Occupy the marker path with a directory so the atomic marker write fails.
  mkdirSync(join(SESSION_DIR, ".ended", key), { recursive: true });

  const response = await handleAgentSession(webhook("ended", id), {});
  expect(response.status).toBe(500);
  expect(existsSync(storedPath(key))).toBe(true);
});

test("concurrent duplicate created during deferred API setup creates one session", async () => {
  const id = "dededede-dede-4ded-8ded-dededededede";
  let release!: () => void;
  let reached!: () => void;
  apiGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const apiReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  apiGateStarted = reached;

  const first = handleAgentSession(webhook("created", id), {});
  const second = handleAgentSession(webhook("created", id), {});
  await apiReached;
  release();
  const responses = await Promise.all([first, second]);
  await awaitReady(id);

  const bodies = await Promise.all(responses.map((r) => r.json()));
  expect(bodies.filter((body) => body.skipped)).toHaveLength(1);
  expect(createdBranches).toEqual([BRANCH]);
  expect(existsSync(storedPath(linearSessionFileKey(id)))).toBe(true);
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toHaveLength(1);
});

test("an end during deferred initial API setup leaves no worktree behind", async () => {
  const id = "efefefef-efef-4efe-8efe-efefefefefef";
  let release!: () => void;
  let reached!: () => void;
  apiGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const apiReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  apiGateStarted = reached;

  const pendingCreate = handleAgentSession(webhook("created", id), {});
  await apiReached;
  const ended = await handleAgentSession(webhook("ended", id), {});
  expect(ended.status).toBe(200);
  release();

  const response = await pendingCreate;
  expect(await response.json()).toMatchObject({ skipped: true });
  expect(createdBranches).toEqual([]);
  expect(existsSync(storedPath(linearSessionFileKey(id)))).toBe(false);
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toEqual([]);
});

test("a duplicate created finishes a failed workspace/transcript setup without another run", async () => {
  const id = "01010101-0101-4101-8101-010101010101";
  const key = linearSessionFileKey(id);
  workspaceFailures = 1;
  transcriptFailures = 1;

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  expect(existsSync(storedPath(key))).toBe(true);
  expect(readStored(key).workspaceId).toBeUndefined();
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toEqual([]);

  // processedSessions elapsed; the live session may only finish setup.
  processedSessions.delete(id);
  const firstRetry = await handleAgentSession(webhook("created", id), {});
  expect(firstRetry.status).toBe(503);
  const secondRetry = await handleAgentSession(webhook("created", id), {});
  expect(await secondRetry.json()).toMatchObject({ initialized: true });

  expect(createdBranches).toEqual([BRANCH]);
  expect(workspaceCalls).toHaveLength(2);
  expect(readStored(key).workspaceId).toBe("ws-linear-test");
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toHaveLength(1);
  expect(runCalls).toEqual([]);
});

test("a null transcript result keeps setup retryable", async () => {
  const id = "03030303-0303-4303-8303-030303030303";
  transcriptUnavailable = true;

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toEqual([]);

  processedSessions.delete(id);
  const failed = await handleAgentSession(webhook("created", id), {});
  expect(failed.status).toBe(503);

  transcriptUnavailable = false;
  const retried = await handleAgentSession(webhook("created", id), {});
  expect(await retried.json()).toMatchObject({ initialized: true });
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toHaveLength(1);
});

test("parallel setup retries share one greeting activity", async () => {
  const id = "02020202-0202-4202-8202-020202020202";
  workspaceFailures = 1;

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toEqual([]);

  let release!: () => void;
  let started!: () => void;
  elicitationGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const reached = new Promise<void>((resolve) => {
    started = resolve;
  });
  elicitationStarted = started;

  processedSessions.delete(id);
  const first = handleAgentSession(webhook("created", id), {});
  const second = handleAgentSession(webhook("created", id), {});
  await reached;
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toHaveLength(1);
  release();
  await Promise.all([first, second]);

  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toHaveLength(1);
  expect(
    transcriptCalls.filter((call) => call.entry.type === "assistant"),
  ).toHaveLength(1);
  expect(createdBranches).toEqual([BRANCH]);
});

test("ending during a slow worktree create removes the checkout and skips the greeting", async () => {
  const id = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
  let release!: () => void;
  createGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await handleAgentSession(webhook("created", id), {});
  const session = activeSessions.get(id)!;
  const ready = session.ready!;
  expect(session.worktreeDir).toBe("");

  await handleAgentSession(webhook("ended", id), {});
  expect(activeSessions.has(id)).toBe(false);
  expect(removedBranches).toEqual([]);

  release();
  await ready;
  await Bun.sleep(0);

  expect(createdBranches).toEqual([BRANCH]);
  expect(removedBranches).toEqual([BRANCH]);
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toEqual([]);
  expect(existsSync(storedPath(linearSessionFileKey(id)))).toBe(false);
});

test("a delayed duplicate created does not replace an in-flight live session", async () => {
  const id = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
  let release!: () => void;
  runGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  const before = activeSessions.get(id)!;

  await handleAgentSession(prompted(id), {});
  await waitFor(() => runCalls.length === 1, "in-flight prompt run");

  // The processedSessions TTL elapsed while the run was still active.
  processedSessions.delete(id);
  const duplicate = await handleAgentSession(webhook("created", id), {});
  expect(await duplicate.json()).toMatchObject({ skipped: true });
  expect(activeSessions.get(id)).toBe(before);
  expect(createdBranches).toEqual([BRANCH]);
  expect(runCalls).toHaveLength(1);

  release();
  await Bun.sleep(10);
});

test("end ordered immediately after a queued save still removes the record", async () => {
  const id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
  const key = linearSessionFileKey(id);

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  const session = activeSessions.get(id)!;

  const pendingSave = persistActiveSession(session);
  const pendingEnd = endLinearSession(id, session.branch);
  const [wrote] = await Promise.all([pendingSave, pendingEnd]);

  expect(wrote).toBe(false);
  expect(existsSync(storedPath(key))).toBe(false);
  expect(await isLinearSessionTerminal(id)).toBe(true);
});

test("issue update resumes the newest live session after restart", async () => {
  const firstId = "12121212-1212-4121-8121-121212121212";
  const secondId = "34343434-3434-4343-8343-343434343434";
  const firstKey = linearSessionFileKey(firstId);
  const secondKey = linearSessionFileKey(secondId);

  await handleAgentSession(webhook("created", firstId), {});
  await awaitReady(firstId);
  activeSessions.get(firstId)!.claudeSessionId = "engine-first";
  await persistActiveSession(activeSessions.get(firstId)!);
  await Bun.sleep(10);

  await handleAgentSession(webhook("created", secondId), {});
  await awaitReady(secondId);
  activeSessions.get(secondId)!.claudeSessionId = "engine-second";
  await persistActiveSession(activeSessions.get(secondId)!);

  // Restart: rebuild the live map from the two store files in arbitrary order.
  activeSessions.clear();
  processedSessions.clear();
  const runtime = {
    accessToken: "synthetic-token",
    issueDescription: ISSUE.description,
    teamId: "team-1",
    planningConversation: [],
  };
  for (const [id, key] of [
    [firstId, firstKey],
    [secondId, secondKey],
  ] as const) {
    const stored = (await loadSessionInfo(key))!;
    activeSessions.set(id, { ...stored, sessionKey: key, ...runtime });
  }

  issueStatus = "In Progress";
  issueHasPlanResult = true;
  await handleIssueUpdate(
    {
      action: "update",
      type: "Issue",
      organizationId: "org-1",
      data: {
        id: ISSUE.id,
        identifier: ISSUE.identifier,
        title: ISSUE.title,
        description: ISSUE.description,
        url: ISSUE.url,
        stateId: "in-progress",
      },
      updatedFrom: { stateId: "todo" },
    },
    {},
  );
  await waitFor(() => runCalls.length === 1, "issue update run");

  expect(runCalls[0]).toMatchObject({
    cwd: `${worktreeRoot}/${BRANCH}-2`,
    sessionId: "engine-second",
  });
  expect(activityCalls.at(-1)?.sessionId).toBe(secondId);
});

test("latest session selection uses persisted updatedAt and excludes ended records", async () => {
  const olderId = "12345678-1234-4123-8123-123456789abc";
  const newerId = "87654321-4321-4321-8321-cba987654321";
  const olderKey = linearSessionFileKey(olderId);
  const newerKey = linearSessionFileKey(newerId);

  writeStored(olderKey, {
    branch: BRANCH,
    linearSessionId: olderId,
    issueId: ISSUE.id,
    issueIdentifier: ISSUE.identifier,
    worktreeDir: `${worktreeRoot}/older`,
    updatedAt: "2026-10-01T10:00:00.000Z",
  });
  writeStored(newerKey, {
    branch: `${BRANCH}-2`,
    linearSessionId: newerId,
    issueId: ISSUE.id,
    issueIdentifier: ISSUE.identifier,
    worktreeDir: `${worktreeRoot}/newer`,
    updatedAt: "2026-10-02T10:00:00.000Z",
  });

  // Simulate reload after restart: records come back from their files.
  const olderStored = (await loadSessionInfo(olderKey))!;
  const newerStored = (await loadSessionInfo(newerKey))!;
  const runtime = {
    accessToken: "",
    issueDescription: "",
    teamId: "",
    planningConversation: [],
  };
  const older = { ...olderStored, sessionKey: olderKey, ...runtime };
  const newer = { ...newerStored, sessionKey: newerKey, ...runtime };

  expect(latestSessionForIssue(ISSUE, [older, newer])).toBe(newer);
  expect(
    latestSessionForIssue(ISSUE, [{ ...older, updatedAt: undefined }, newer]),
  ).toBe(newer);
  expect(latestSessionForIssue(ISSUE, [older, { ...newer, ended: true }])).toBe(
    older,
  );
});

test("a queued engine-id sync preserves a concurrent session save", async () => {
  const id = "cdcdcdcd-cdcd-4cdc-8cdc-cdcdcdcdcdcd";
  const key = linearSessionFileKey(id);
  const { syncAgentSessionEngine } =
    await import("../../server/agent-session-sync");

  const saving = saveSessionInfo(key, {
    branch: BRANCH,
    linearSessionId: id,
    issueIdentifier: ISSUE.identifier,
    issueTitle: ISSUE.title,
    worktreeDir: `${worktreeRoot}/raced`,
    claudeSessionId: "engine-old",
    model: "model-a",
  });
  const syncing = syncAgentSessionEngine(
    {
      id: `linear-${key}`,
      source: "linear",
      branch: BRANCH,
      linearSessionId: id,
    },
    { engineSessionId: "engine-new" },
  );
  expect(await Promise.all([saving, syncing])).toEqual([true, true]);

  // Both writers share the per-file chain: the sync lands after the save, so
  // the save cannot overwrite the fresh engine id.
  expect(readStored(key)).toMatchObject({
    branch: BRANCH,
    linearSessionId: id,
    claudeSessionId: "engine-new",
    model: "model-a",
    issueTitle: ISSUE.title,
  });
});

test("store writes and deletes are scoped to the owning agent-session id", async () => {
  const owner = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
  const other = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb";
  const key = linearSessionFileKey(owner);

  await saveSessionInfo(key, {
    branch: BRANCH,
    linearSessionId: owner,
    issueIdentifier: ISSUE.identifier,
    issueTitle: ISSUE.title,
    worktreeDir: `${worktreeRoot}/owned`,
  });
  const before = readStored(key);

  // A late writer with another id may not relabel the record.
  await saveSessionInfo(key, { linearSessionId: other, worktreeDir: "/wrong" });
  expect(readStored(key)).toEqual(before);

  // A cleanup for another id may not delete it.
  expect(await deleteSessionFile(key, other)).toBe(false);
  expect(readStored(key)).toEqual(before);

  // The owner's cleanup removes it exactly once.
  expect(await deleteSessionFile(key, owner)).toBe(true);
  expect(existsSync(storedPath(key))).toBe(false);

  // A late save for the ended owner cannot recreate its record, even though
  // the file is already gone.
  await markLinearSessionTerminal(owner);
  expect(
    await saveSessionInfo(key, {
      branch: BRANCH,
      linearSessionId: owner,
      worktreeDir: `${worktreeRoot}/late`,
    }),
  ).toBe(false);
  expect(existsSync(storedPath(key))).toBe(false);

  // Ending by id is scoped the same way.
  const secondOwner = "abababab-abab-4bab-8bab-abababababab";
  const secondKey = linearSessionFileKey(secondOwner);
  await saveSessionInfo(secondKey, {
    linearSessionId: secondOwner,
    branch: BRANCH,
  });
  const ended = await endLinearSession(other, BRANCH);
  expect(ended.owned).toBe(false);
  expect(existsSync(storedPath(secondKey))).toBe(true);
});
