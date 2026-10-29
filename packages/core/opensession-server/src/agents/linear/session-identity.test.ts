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
import { afterEach, beforeEach, expect, mock, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const worktreeRoot = "/synthetic-worktrees";
let prRepo: { ghRepo: string; host: string } | undefined;
let headBranch: string | null = "fix-the-eng1";
const credentialCalls: string[] = [];
let prCredentialEnv: Record<string, string> = {};
const realSpawn = Bun.spawn;
let ghResponses: Array<{ stdout?: string; stderr?: string; code?: number }> =
  [];
let ghCalls: Array<{ args: string[]; opts: any }> = [];

function mockGh(
  responses: Array<{ stdout?: string; stderr?: string; code?: number }>,
) {
  ghResponses = responses.map((response) => ({ ...response }));
  ghCalls = [];
  return spyOn(Bun, "spawn").mockImplementation(((
    args: string[],
    opts: Record<string, unknown>,
  ) => {
    ghCalls.push({ args, opts });
    const spec = ghResponses.shift() ?? {};
    return realSpawn(
      [
        "/bin/sh",
        "-c",
        'printf %s "$1"; printf %s "$2" >&2; exit "$3"',
        "sh",
        spec.stdout ?? "",
        spec.stderr ?? "",
        String(spec.code ?? 0),
      ],
      { stdout: "pipe", stderr: "pipe" },
    ) as any;
  }) as any);
}
const createdBranches: string[] = [];
const removedBranches: string[] = [];
const removedRepoIds: Array<string | undefined> = [];
const usedBranches = new Set<string>();
const runCalls: Array<Record<string, unknown>> = [];
const activityCalls: Array<{ sessionId: string; content: any }> = [];
const linkCalls: Array<{ sessionId: string; urls: string[] }> = [];
const workspaceCalls: Array<Record<string, unknown>> = [];
const transcriptCalls: Array<{ sessionId: string; entry: any }> = [];
const movedStatuses: Array<{ issueId: string; status: string }> = [];
let runResult = "";
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
let moveGate: Promise<void> | null = null;
let moveStarted: (() => void) | null = null;
let thoughtGate: Promise<void> | null = null;
let thoughtStarted: (() => void) | null = null;

mock.module("../../server/worktree", () => ({
  repoForPathOrNull: (cwd: string) =>
    cwd.startsWith(`${worktreeRoot}/`) ? prRepo : undefined,
  worktreeHeadBranch: () => headBranch,
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
  removeWorktree: async (branch: string, repoId?: string) => {
    removedBranches.push(branch);
    removedRepoIds.push(repoId);
  },
}));

mock.module("../../server/github-app", () => ({
  githubServiceCredentialEnv: async (ghRepo: string) => {
    credentialCalls.push(ghRepo);
    return prCredentialEnv;
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
    if (
      content.type === "thought" &&
      String(content.body).includes("Starting planning")
    ) {
      const gate = thoughtGate;
      thoughtGate = null;
      thoughtStarted?.();
      thoughtStarted = null;
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
  moveToStatus: async (
    token: string,
    issueId: string,
    teamId: string,
    status: string,
  ) => {
    movedStatuses.push({ issueId, status });
    const gate = moveGate;
    moveGate = null;
    moveStarted?.();
    moveStarted = null;
    if (gate) await gate;
    return true;
  },
  postComment: async () => true,
  fetchLinearUser: async () => null,
}));

let validToken: string | null = "synthetic-token";

mock.module("./oauth", () => ({
  getValidToken: async () => validToken,
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
      result: runResult,
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
  createPrWithAttribution,
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

function prompted(id: string, body = "go ahead", activityId?: string) {
  return webhook("prompted", id, {
    agentActivity: {
      ...(activityId ? { id: activityId } : {}),
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

async function waitForAssignmentSettled(id: string) {
  await waitFor(() => {
    const status = activeSessions.get(id)?.assignmentStart?.status;
    return (
      status === "completed" || status === "failed" || status === "cancelled"
    );
  }, "assignment settlement");
}

beforeEach(() => {
  prRepo = { ghRepo: "acme/linear-repo", host: "github" };
  headBranch = "fix-the-eng1";
  ghResponses = [];
  ghCalls = [];
  validToken = "synthetic-token";
  credentialCalls.length = 0;
  prCredentialEnv = { GH_TOKEN: "synthetic-installation-token" };
  activeSessions.clear();
  processedSessions.clear();
  (globalThis as any).__linearEndedAgentSessions?.clear();
  createdBranches.length = 0;
  removedBranches.length = 0;
  removedRepoIds.length = 0;
  usedBranches.clear();
  runCalls.length = 0;
  activityCalls.length = 0;
  linkCalls.length = 0;
  workspaceCalls.length = 0;
  transcriptCalls.length = 0;
  movedStatuses.length = 0;
  runResult = "";
  delete process.env.LINEAR_START_MODE;
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
  moveGate = null;
  moveStarted = null;
  thoughtGate = null;
  thoughtStarted = null;
  mkdirSync(SESSION_DIR, { recursive: true });
});

afterEach(() => {
  activeSessions.clear();
  processedSessions.clear();
  (globalThis as any).__linearEndedAgentSessions?.clear();
  delete process.env.LINEAR_START_MODE;
});

test("automatic PR creation passes fresh repository App credentials to gh", async () => {
  const url = "https://github.com/acme/linear-repo/pull/42";
  const spawn = mockGh([{ stdout: "[]" }, { stdout: `${url}\n` }, {}]);
  const oldToken = process.env.GH_TOKEN;
  process.env.GH_TOKEN = "unrelated-host-token";
  try {
    prCredentialEnv = {
      GH_TOKEN: "synthetic-installation-token",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: "credential.helper",
      GIT_CONFIG_VALUE_0: "synthetic-helper",
    };
    const result = await createPrWithAttribution(
      `${worktreeRoot}/task`,
      "ENG-1",
      ISSUE.url,
      ISSUE.title,
      [],
      "reviewer",
    );
    expect(result).toEqual({ url });
    expect(credentialCalls).toEqual(["acme/linear-repo"]);
    expect(ghCalls).toHaveLength(3);
    expect(ghCalls[0]!.args.slice(0, 4)).toEqual([
      "gh",
      "pr",
      "list",
      "--repo",
    ]);
    expect(ghCalls[0]!.args).toContain(headBranch!);
    expect(ghCalls[1]!.args.slice(0, 4)).toEqual([
      "gh",
      "pr",
      "create",
      "--title",
    ]);
    expect(ghCalls[1]!.args).not.toContain("--reviewer");
    expect(ghCalls[2]!.args).toEqual([
      "gh",
      "pr",
      "edit",
      url,
      "--add-reviewer",
      "reviewer",
    ]);
    for (const call of ghCalls) {
      expect(call.opts).toEqual(
        expect.objectContaining({
          cwd: `${worktreeRoot}/task`,
          env: expect.objectContaining(prCredentialEnv),
        }),
      );
    }
  } finally {
    spawn.mockRestore();
    if (oldToken === undefined) delete process.env.GH_TOKEN;
    else process.env.GH_TOKEN = oldToken;
  }
});

test("automatic PR creation reuses an existing open PR", async () => {
  const url = "https://github.com/acme/linear-repo/pull/7";
  const spawn = mockGh([{ stdout: JSON.stringify([{ url }]) }]);
  try {
    const result = await createPrWithAttribution(
      `${worktreeRoot}/task`,
      "ENG-1",
      ISSUE.url,
      ISSUE.title,
      [],
    );
    expect(result).toEqual({ url });
    expect(ghCalls).toHaveLength(1);
    expect(ghCalls[0]!.args.slice(0, 2)).toEqual(["gh", "pr"]);
    expect(ghCalls[0]!.args[2]).toBe("list");
  } finally {
    spawn.mockRestore();
  }
});

test("automatic PR creation recovers a PR that gh created before failing", async () => {
  const url = "https://github.com/acme/linear-repo/pull/8";
  const spawn = mockGh([
    { stdout: "[]" },
    { code: 1, stderr: "failed to add reviewers: HTTP 422" },
    { stdout: JSON.stringify([{ url }]) },
  ]);
  try {
    const result = await createPrWithAttribution(
      `${worktreeRoot}/task`,
      "ENG-1",
      ISSUE.url,
      ISSUE.title,
      [],
    );
    expect(result).toEqual({ url });
    expect(ghCalls).toHaveLength(3);
  } finally {
    spawn.mockRestore();
  }
});

test("a rejected reviewer request does not hide a created PR", async () => {
  const url = "https://github.com/acme/linear-repo/pull/9";
  const spawn = mockGh([
    { stdout: "[]" },
    { stdout: `${url}\n` },
    { code: 1, stderr: "could not resolve reviewer" },
  ]);
  try {
    const result = await createPrWithAttribution(
      `${worktreeRoot}/task`,
      "ENG-1",
      ISSUE.url,
      ISSUE.title,
      [],
      "not-a-collaborator",
    );
    expect(result).toEqual({ url });
  } finally {
    spawn.mockRestore();
  }
});

test("automatic PR creation fails closed without a repository App token", async () => {
  const spawn = spyOn(Bun, "spawn");
  try {
    prCredentialEnv = { GH_TOKEN: "" };
    const result = await createPrWithAttribution(
      `${worktreeRoot}/task`,
      "ENG-1",
      ISSUE.url,
      ISSUE.title,
      [],
    );
    expect(result.url).toBeNull();
    expect(result.reason).toContain("credentials are unavailable");
    expect(credentialCalls).toEqual(["acme/linear-repo"]);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});

test("automatic PR creation does not mint credentials for an unknown worktree", async () => {
  const spawn = spyOn(Bun, "spawn");
  try {
    prRepo = undefined;
    const result = await createPrWithAttribution(
      `${worktreeRoot}/task`,
      "ENG-1",
      ISSUE.url,
      ISSUE.title,
      [],
    );
    expect(result.url).toBeNull();
    expect(result.reason).toContain("no registered GitHub repository");
    expect(credentialCalls).toEqual([]);
    expect(spawn).not.toHaveBeenCalled();
  } finally {
    spawn.mockRestore();
  }
});

test("a repeated implementation turn reuses the stored PR after a restart", async () => {
  const id = "7d7d7d7d-7d7d-4d7d-8d7d-7d7d7d7d7d7d";
  const key = linearSessionFileKey(id);
  const url = "https://github.com/acme/linear-repo/pull/55";
  const spawn = mockGh([{ stdout: "[]" }, { stdout: `${url}\n` }]);
  try {
    await handleAgentSession(webhook("created", id), {});
    await awaitReady(id);

    runResult = "Implemented. IMPLEMENTATION_COMPLETE";
    await handleAgentSession(prompted(id, "implement", "activity-pr-1"), {});
    await waitFor(
      () =>
        activityCalls.some((call) =>
          String(call.content.body).includes(`PR: ${url}`),
        ),
      "first PR activity",
    );
    expect(readStored(key).prUrl).toBe(url);

    // Restart: the in-memory URL is gone, the agent-session file keeps it.
    activeSessions.clear();
    processedSessions.clear();

    runResult = "Implemented again. IMPLEMENTATION_COMPLETE";
    await handleAgentSession(
      prompted(id, "implement again", "activity-pr-2"),
      {},
    );
    await waitFor(
      () =>
        activityCalls.filter((call) =>
          String(call.content.body).includes(`PR: ${url}`),
        ).length === 2,
      "second PR activity",
    );

    // list + create for the first turn only; the retry made no gh calls.
    expect(ghCalls).toHaveLength(2);
  } finally {
    spawn.mockRestore();
  }
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

test("a prompted turn with no usable token is retried instead of dropped", async () => {
  const id = "78787878-7878-4878-8878-787878787878";

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  expect(runCalls).toHaveLength(0);

  validToken = null;
  const dropped = await handleAgentSession(prompted(id), {});
  expect(dropped.status).toBe(503);
  expect(await dropped.json()).toMatchObject({ retryable: true });
  expect(runCalls).toHaveLength(0);

  // Linear redelivers once authorization is restored: the same prompt runs.
  validToken = "synthetic-token";
  await handleAgentSession(prompted(id), {});
  await waitFor(() => runCalls.length === 1, "retried prompted run");
});

test("a reassigned session runs while the previous session is still unwinding", async () => {
  const first = "79797979-7979-4979-8979-797979797979";
  const second = "7a7a7a7a-7a7a-4a7a-8a7a-7a7a7a7a7a7a";
  let release!: () => void;
  runGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await handleAgentSession(webhook("created", first), {});
  await awaitReady(first);
  await handleAgentSession(prompted(first, "first turn"), {});
  await waitFor(() => runCalls.length === 1, "first session run");

  // Dismiss+reassign while the first turn is still running. The new agent
  // session gets its own worktree, so it must not wait on the old checkout.
  await handleAgentSession(webhook("created", second), {});
  await awaitReady(second);
  expect(activeSessions.get(second)?.branch).not.toBe(
    activeSessions.get(first)?.branch,
  );

  await handleAgentSession(prompted(second, "second turn"), {});
  await waitFor(() => runCalls.length === 2, "reassigned session run");

  expect(activityCalls).not.toContainEqual(
    expect.objectContaining({
      sessionId: second,
      content: expect.objectContaining({
        body: expect.stringContaining("still working"),
      }),
    }),
  );

  release();
  await waitFor(
    () => activeSessions.get(first)?.abortController === undefined,
    "first run teardown",
  );
  await waitFor(
    () => activeSessions.get(second)?.abortController === undefined,
    "second run teardown",
  );
});

test("a redelivered prompt activity does not run a second turn", async () => {
  const id = "7b7b7b7b-7b7b-4b7b-8b7b-7b7b7b7b7b7b";
  const key = linearSessionFileKey(id);
  const activityId = "activity-duplicate-1";

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  await handleAgentSession(prompted(id, "go ahead", activityId), {});
  await waitFor(() => runCalls.length === 1, "first prompt run");

  expect(readStored(key).processedPromptIds).toContain(activityId);

  const replay = await handleAgentSession(
    prompted(id, "go ahead", activityId),
    {},
  );
  expect(await replay.json()).toMatchObject({ duplicate: true });
  await Bun.sleep(20);
  expect(runCalls).toHaveLength(1);
});

test("a processed prompt stays deduplicated after a restart", async () => {
  const id = "7c7c7c7c-7c7c-4c7c-8c7c-7c7c7c7c7c7c";
  const activityId = "activity-duplicate-2";

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  await handleAgentSession(prompted(id, "go ahead", activityId), {});
  await waitFor(() => runCalls.length === 1, "first prompt run");

  // Restart: the live map is gone; only the durable agent-session file and the
  // captured activity id remain.
  activeSessions.clear();
  processedSessions.clear();

  const replay = await handleAgentSession(
    prompted(id, "go ahead", activityId),
    {},
  );
  expect(await replay.json()).toMatchObject({ duplicate: true });
  await Bun.sleep(20);
  expect(runCalls).toHaveLength(1);
});

test("ending a session removes the checkout in its recorded repo", async () => {
  const id = "7f7f7f7f-7f7f-4f7f-8f7f-7f7f7f7f7f7f";
  const key = linearSessionFileKey(id);

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  await saveSessionInfo(key, { repoId: "legacy-repo" });

  // Restart: the in-memory session is gone; the file's repoId is the only
  // record of which repository owns the checkout.
  activeSessions.clear();
  processedSessions.clear();

  await handleAgentSession(webhook("ended", id), {});
  expect(removedBranches).toEqual([BRANCH]);
  expect(removedRepoIds).toEqual(["legacy-repo"]);
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

test("stop during deferred initial API setup prevents later autostart", async () => {
  process.env.LINEAR_START_MODE = "plan";
  const id = "12121212-1212-4212-8212-121212121212";
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
  await handleAgentSession(
    webhook("prompted", id, {
      agentActivity: { signal: "stop", content: { type: "prompt", body: "" } },
    }),
    {},
  );
  release();
  const response = await pendingCreate;
  await response.json();
  await awaitReady(id);
  await Bun.sleep(10);

  expect(runCalls).toEqual([]);
  expect(activeSessions.get(id)?.assignmentStart).toBeUndefined();
  expect(
    await import("./session-store").then((m) =>
      m.isLinearAssignmentStopped(id),
    ),
  ).toBe(true);

  activeSessions.clear();
  processedSessions.clear();
  const replay = await handleAgentSession(webhook("created", id), {});
  await replay.json();
  await Bun.sleep(10);
  expect(runCalls).toEqual([]);
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

test("ask mode keeps the greeting and starts no assignment run", async () => {
  const id = "04040404-0404-4404-8404-040404040404";
  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);

  expect(runCalls).toEqual([]);
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toHaveLength(1);
  expect(
    transcriptCalls.filter((call) => call.entry.type === "assistant"),
  ).toHaveLength(1);
  expect(activeSessions.get(id)?.startMode).toBe("ask");
  expect(activeSessions.get(id)?.assignmentStart).toBeUndefined();
});

test("plan mode starts planning, skips the greeting and keeps the Ready gate", async () => {
  process.env.LINEAR_START_MODE = "plan";
  runResult = "Plan body PLANNING_COMPLETE";
  const id = "05050505-0505-4505-8505-050505050505";

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  await waitForAssignmentSettled(id);

  expect(runCalls).toHaveLength(1);
  expect(String(runCalls[0]?.prompt)).toContain("PLANNING");
  expect(runCalls[0]).toMatchObject({
    promptEntryText: `Start planning for ${ISSUE.identifier}`,
  });
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toHaveLength(1);
  expect(
    transcriptCalls.filter((call) => call.entry.type === "assistant"),
  ).toEqual([]);
  expect(movedStatuses).toContainEqual({
    issueId: ISSUE.id,
    status: "Ready",
  });
  expect(activeSessions.get(id)?.phase).toBe("awaiting_implementation");
  expect(activeSessions.get(id)?.assignmentStart).toMatchObject({
    mode: "plan",
    status: "completed",
  });
});

test("implement mode is explicit opt-in, moves In Progress and skips the greeting", async () => {
  process.env.LINEAR_START_MODE = "implement";
  const id = "06060606-0606-4606-8606-060606060606";

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  await waitForAssignmentSettled(id);

  expect(runCalls).toHaveLength(1);
  expect(String(runCalls[0]?.prompt)).toContain("IMPLEMENTATION");
  expect(runCalls[0]).toMatchObject({
    promptEntryText: `Start implementation for ${ISSUE.identifier}`,
  });
  expect(movedStatuses).toContainEqual({
    issueId: ISSUE.id,
    status: "In Progress",
  });
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toEqual([]);
  expect(
    transcriptCalls.filter((call) => call.entry.type === "assistant"),
  ).toEqual([]);
  expect(activeSessions.get(id)?.assignmentStart).toMatchObject({
    mode: "implement",
    status: "completed",
  });
});

test("a completed assignment is not launched again after restart", async () => {
  process.env.LINEAR_START_MODE = "plan";
  const id = "07070707-0707-4707-8707-070707070707";
  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  await waitForAssignmentSettled(id);
  expect(runCalls).toHaveLength(1);

  activeSessions.clear();
  processedSessions.clear();
  const replay = await handleAgentSession(webhook("created", id), {});
  await replay.json();
  await Bun.sleep(10);

  expect(runCalls).toHaveLength(1);
  expect(readStored(linearSessionFileKey(id)).assignmentStart).toMatchObject({
    mode: "plan",
    status: "completed",
  });
});

test("stop during setup prevents the assignment run", async () => {
  process.env.LINEAR_START_MODE = "plan";
  const id = "08080808-0808-4808-8808-080808080808";
  let release!: () => void;
  createGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await handleAgentSession(webhook("created", id), {});
  await handleAgentSession(
    webhook("prompted", id, {
      agentActivity: { signal: "stop", content: { type: "prompt", body: "" } },
    }),
    {},
  );
  release();
  await awaitReady(id);

  expect(runCalls).toEqual([]);
  expect(activeSessions.get(id)?.assignmentStart).toBeUndefined();
});

test("concurrent duplicate created during an assignment run starts only one turn", async () => {
  process.env.LINEAR_START_MODE = "plan";
  const id = "0a0a0a0a-0a0a-4a0a-8a0a-0a0a0a0a0a0a";
  let release!: () => void;
  runGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await handleAgentSession(webhook("created", id), {});
  await waitFor(() => runCalls.length === 1, "assignment run");
  const duplicate = await handleAgentSession(webhook("created", id), {});
  expect(await duplicate.json()).toMatchObject({ skipped: true });
  release();
  await awaitReady(id);
  await waitForAssignmentSettled(id);

  expect(runCalls).toHaveLength(1);
  expect(activeSessions.get(id)?.assignmentStart).toMatchObject({
    mode: "plan",
    status: "completed",
  });
});

test("a setup failure retry starts the assignment once after setup succeeds", async () => {
  process.env.LINEAR_START_MODE = "plan";
  workspaceFailures = 1;
  const id = "0b0b0b0b-0b0b-4b0b-8b0b-0b0b0b0b0b0b";

  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  expect(runCalls).toEqual([]);

  processedSessions.delete(id);
  const retried = await handleAgentSession(webhook("created", id), {});
  await retried.json();
  await awaitReady(id);
  await waitForAssignmentSettled(id);

  expect(runCalls).toHaveLength(1);
  expect(activeSessions.get(id)?.assignmentStart).toMatchObject({
    mode: "plan",
    status: "completed",
  });
});

test("a completed plan waits for approval before implementation", async () => {
  process.env.LINEAR_START_MODE = "plan";
  runResult = "Plan body PLANNING_COMPLETE";
  const id = "0d0d0d0d-0d0d-4d0d-8d0d-0d0d0d0d0d0d";
  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  await waitForAssignmentSettled(id);
  expect(activeSessions.get(id)?.phase).toBe("awaiting_implementation");
  expect(runCalls).toHaveLength(1);

  runResult = "";
  await handleAgentSession(prompted(id, "go ahead"), {});
  await waitFor(() => runCalls.length === 2, "approval implementation run");
  expect(movedStatuses).toContainEqual({
    issueId: ISSUE.id,
    status: "In Progress",
  });
});

test("a replay ACKs after dispatch without waiting for the model turn", async () => {
  process.env.LINEAR_START_MODE = "plan";
  const id = "11111111-2222-4333-8444-555555555555";
  const key = linearSessionFileKey(id);
  writeStored(key, {
    branch: BRANCH,
    linearSessionId: id,
    issueId: ISSUE.id,
    issueIdentifier: ISSUE.identifier,
    issueTitle: ISSUE.title,
    issueUrl: ISSUE.url,
    worktreeDir: `${worktreeRoot}/${BRANCH}`,
    phase: "awaiting_direction",
    startMode: "plan",
    workspaceId: "ws-linear-test",
    greetingPostedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  let release!: () => void;
  runGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  const replay = await handleAgentSession(webhook("created", id), {});
  expect(await replay.json()).toMatchObject({ reused: true });
  expect(runCalls).toHaveLength(1);
  expect(activeSessions.get(id)?.assignmentStart).toMatchObject({
    mode: "plan",
    status: "dispatched",
  });

  release();
  await waitForAssignmentSettled(id);
  expect(activeSessions.get(id)?.assignmentStart).toMatchObject({
    status: "completed",
  });
});

test("an uncertain assignment claim reports needs-retry without running", async () => {
  process.env.LINEAR_START_MODE = "plan";
  const id = "0c0c0c0c-0c0c-4c0c-8c0c-0c0c0c0c0c0c";
  const key = linearSessionFileKey(id);
  writeStored(key, {
    branch: BRANCH,
    linearSessionId: id,
    issueId: ISSUE.id,
    issueIdentifier: ISSUE.identifier,
    issueTitle: ISSUE.title,
    issueUrl: ISSUE.url,
    worktreeDir: `${worktreeRoot}/${BRANCH}`,
    phase: "planning",
    startMode: "plan",
    workspaceId: "ws-linear-test",
    greetingPostedAt: new Date().toISOString(),
    assignmentStart: {
      mode: "plan",
      status: "dispatched",
      claimedAt: new Date().toISOString(),
    },
    updatedAt: new Date().toISOString(),
  });

  const response = await handleAgentSession(webhook("created", id), {});
  expect(await response.json()).toMatchObject({ reused: true });
  await Bun.sleep(10);

  expect(runCalls).toEqual([]);
  expect(
    activityCalls.filter(
      (call) =>
        call.content.type === "response" &&
        String(call.content.body).includes("interrupted"),
    ),
  ).toHaveLength(1);
  expect(readStored(key).assignmentStart).toMatchObject({
    status: "dispatched",
    noticeAt: expect.any(String),
  });
});

test("assignment status and thought side effects wait for the claimed guard", async () => {
  process.env.LINEAR_START_MODE = "implement";
  const id = "0e0e0e0e-0e0e-4e0e-8e0e-0e0e0e0e0e0e";
  let release!: () => void;
  let reached!: () => void;
  moveGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const moveReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  moveStarted = reached;

  await handleAgentSession(webhook("created", id), {});
  await moveReached;
  const session = activeSessions.get(id)!;
  session.claudeSessionId = "engine-existing";
  issueStatus = "In Progress";
  issueHasPlanResult = true;

  const duplicate = await handleAgentSession(webhook("created", id), {});
  expect(await duplicate.json()).toMatchObject({ skipped: true });
  const prompt = handleAgentSession(prompted(id), {});
  const issueUpdate = handleIssueUpdate(
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
  await issueUpdate;
  expect(runCalls).toEqual([]);
  expect(
    movedStatuses.filter((move) => move.status === "In Progress"),
  ).toHaveLength(1);

  release();
  await awaitReady(id);
  await prompt;
  await waitForAssignmentSettled(id);
  expect(runCalls).toHaveLength(1);
  expect(
    movedStatuses.filter((move) => move.status === "In Progress"),
  ).toHaveLength(1);
});

test("ending during a pending claim never starts the runner or revives the file", async () => {
  process.env.LINEAR_START_MODE = "implement";
  const id = "0f0f0f0f-0f0f-4f0f-8f0f-0f0f0f0f0f0f";
  const key = linearSessionFileKey(id);
  let release!: () => void;
  let reached!: () => void;
  moveGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const moveReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  moveStarted = reached;

  await handleAgentSession(webhook("created", id), {});
  await moveReached;
  await handleAgentSession(webhook("ended", id), {});
  release();
  await Bun.sleep(20);

  expect(runCalls).toEqual([]);
  expect(existsSync(storedPath(key))).toBe(false);
});

test("stop during a pending claim cancels the assignment without a runner", async () => {
  process.env.LINEAR_START_MODE = "plan";
  const id = "10101010-1010-4010-8010-101010101010";
  const key = linearSessionFileKey(id);
  let release!: () => void;
  let reached!: () => void;
  thoughtGate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const thoughtReached = new Promise<void>((resolve) => {
    reached = resolve;
  });
  thoughtStarted = reached;

  await handleAgentSession(webhook("created", id), {});
  await thoughtReached;
  await handleAgentSession(
    webhook("prompted", id, {
      agentActivity: { signal: "stop", content: { type: "prompt", body: "" } },
    }),
    {},
  );
  release();
  await Bun.sleep(20);

  expect(runCalls).toEqual([]);
  expect(readStored(key).assignmentStart).toMatchObject({
    status: "cancelled",
  });
});

test("stop after the runner returns cancels instead of completing the assignment", async () => {
  process.env.LINEAR_START_MODE = "plan";
  const id = "13131313-1313-4313-8313-131313131313";
  let release!: () => void;
  runGate = new Promise<void>((resolve) => {
    release = resolve;
  });

  await handleAgentSession(webhook("created", id), {});
  await waitFor(() => runCalls.length === 1, "assignment runner");
  await handleAgentSession(
    webhook("prompted", id, {
      agentActivity: { signal: "stop", content: { type: "prompt", body: "" } },
    }),
    {},
  );
  release();
  await waitForAssignmentSettled(id);

  expect(activeSessions.get(id)?.assignmentStart).toMatchObject({
    mode: "plan",
    status: "cancelled",
  });
  expect(
    activityCalls.filter((call) => call.content.type === "elicitation"),
  ).toEqual([]);
});

test("an assignment error is not silently retried", async () => {
  process.env.LINEAR_START_MODE = "plan";
  runResult = "Error: synthetic failure";
  const id = "09090909-0909-4909-8909-090909090909";
  await handleAgentSession(webhook("created", id), {});
  await awaitReady(id);
  await waitForAssignmentSettled(id);

  expect(runCalls).toHaveLength(1);
  expect(activeSessions.get(id)?.assignmentStart).toMatchObject({
    mode: "plan",
    status: "failed",
  });
  processedSessions.delete(id);
  await handleAgentSession(webhook("created", id), {});
  await Bun.sleep(10);
  expect(runCalls).toHaveLength(1);
});

test("ending during a slow worktree create removes the checkout and skips the greeting", async () => {
  process.env.LINEAR_START_MODE = "plan";
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
  expect(runCalls).toEqual([]);
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
