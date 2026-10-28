/**
 * Builds and rollouts a session follows, for the live card in the session.
 *
 * Fed by GitHub webhooks the App already receives, so nothing here polls:
 *  - `workflow_run` on the session's branch: its CI.
 *  - `pull_request` merged: remembers the merge commit for the sessions that
 *    own the branch, so the runs its push starts (a deploy workflow, for
 *    one) show in those sessions too.
 *  - `workflow_job`: job progress and the failed step of a run shown here.
 *  - `status` with a `cd/<target>/<app>` context on a remembered merge
 *    commit: a rollout as a continuous delivery tool reports it (Argo CD's
 *    GitHub notifications post exactly this shape).
 *
 * Rows are UI state, not agent state: nothing here wakes a turn. Waits
 * (agent-waits.ts) and the CI failure notice (agents/github/ci-failure.ts)
 * stay the agent's channel.
 *
 * Kept in memory with a debounced async snapshot, so a restart keeps the
 * card. Rows and merges are dropped a day after their last change. A run is
 * tracked only so its job events find it: it is dropped an hour after it
 * ends, which keeps the snapshot small on a busy organization.
 *
 * Kill switch: OPENSESSION_SESSION_BUILDS=0.
 */
import { readFile } from "node:fs/promises";
import type { SessionBuildWire } from "@tellahq/opensession-protocol/session";
import { stateDir } from "./paths";
import { writeFileAtomicAsync } from "./shared/atomic-write";

export type SessionBuild = SessionBuildWire;

/** A registered repository as the webhook resolved it. */
export interface BuildRepo {
  id: string;
  ghRepo: string;
  defaultBranch?: string;
}

interface TrackedMerge {
  sessionIds: string[];
  prNumber: number;
  branch: string;
  at: number;
}

interface TrackedJob {
  name: string;
  done: boolean;
  failed: boolean;
  failedStep?: string;
}

interface TrackedRun {
  sessionIds: string[];
  attempt: number;
  jobs: Record<string, TrackedJob>;
  at: number;
  /** The attempt reported its end. GitHub can deliver a fast run's
   * `in_progress` after its `completed`, and that must not revive it. */
  ended?: boolean;
}

const RETAIN_MS = 24 * 60 * 60_000;
/** Late job events for an ended run arrive within minutes, and an unknown
 * run's job events are ignored, so an ended run needs no long memory. */
const ENDED_RUN_RETAIN_MS = 60 * 60_000;
const MAX_ROWS_PER_SESSION = 40;
const BRANCH_CACHE_MS = 30_000;
const BROADCAST_DEBOUNCE_MS = 300;
/** The snapshot only restores UI cards after a restart; a short loss is fine,
 * and webhooks arrive every second on a busy organization. */
const SAVE_DEBOUNCE_MS = 15_000;
export const ROLLOUT_CONTEXT_PREFIX = "cd/";

const FAILED = new Set(["failure", "timed_out", "startup_failure"]);

export interface SessionBuildDeps {
  /** Live sessions that own `repo:branch` (session-matching matchSessions). */
  sessionsForBranch(repoId: string, branch: string): Promise<string[]>;
  broadcast(sessionId: string, builds: SessionBuild[]): void;
  load(): Promise<string | null>;
  save(json: string): Promise<void>;
  now(): number;
  setTimer(fn: () => void, ms: number): unknown;
}

const snapshotPath = () => stateDir("session-builds.json");

const defaultDeps: SessionBuildDeps = {
  sessionsForBranch: async (repoId, branch) => {
    const { matchSessions } = await import("../agents/github/session-matching");
    try {
      return (await matchSessions(repoId, branch)).map((s) => s.id);
    } catch {
      // More owners than a branch plausibly has: show it nowhere.
      return [];
    }
  },
  broadcast: (sessionId, builds) => {
    void import("./ws-hub").then(({ broadcastToSession }) =>
      broadcastToSession(sessionId, {
        type: "session_builds",
        sessionId,
        builds,
      }),
    );
  },
  load: () => readFile(snapshotPath(), "utf-8").catch(() => null),
  // Already serialized: write the text as is rather than parse and
  // re-serialize it on the gateway thread.
  save: (json) => writeFileAtomicAsync(snapshotPath(), json),
  now: () => Date.now(),
  setTimer: (fn, ms) => setTimeout(fn, ms),
};

let deps: SessionBuildDeps = defaultDeps;

const state = {
  loaded: null as Promise<void> | null,
  merges: new Map<string, TrackedMerge>(),
  runs: new Map<string, TrackedRun>(),
  rows: new Map<string, Map<string, SessionBuild>>(),
  branchCache: new Map<string, { ids: string[]; at: number }>(),
  dirty: new Set<string>(),
  broadcastTimer: null as unknown,
  saveTimer: null as unknown,
};

/** Test seam: replace dependencies and start from an empty registry. */
export function __resetSessionBuildsForTest(
  overrides?: Partial<SessionBuildDeps>,
): void {
  deps = { ...defaultDeps, ...overrides };
  state.loaded = Promise.resolve();
  state.merges.clear();
  state.runs.clear();
  state.rows.clear();
  state.branchCache.clear();
  state.dirty.clear();
  state.broadcastTimer = null;
  state.saveTimer = null;
}

/** Test seam: send pending frames now instead of after the debounce. */
export function __flushSessionBuildsForTest(): void {
  flushBroadcasts();
}

export function sessionBuildsEnabled(): boolean {
  return process.env.OPENSESSION_SESSION_BUILDS !== "0";
}

const repoKey = (ghRepo: string) => ghRepo.toLowerCase();
const mergeKey = (ghRepo: string, sha: string) => `${repoKey(ghRepo)}@${sha}`;
const runKey = (ghRepo: string, runId: number) => `${repoKey(ghRepo)}#${runId}`;

function ensureLoaded(): Promise<void> {
  state.loaded ??= deps
    .load()
    .then((text) => {
      if (!text) return;
      const snap = JSON.parse(text);
      for (const [k, v] of Object.entries(snap?.merges ?? {}))
        state.merges.set(k, v as TrackedMerge);
      for (const [k, v] of Object.entries(snap?.runs ?? {}))
        state.runs.set(k, v as TrackedRun);
      for (const [sessionId, rows] of Object.entries(snap?.rows ?? {}))
        state.rows.set(
          sessionId,
          new Map(
            (rows as SessionBuild[]).map((row): [string, SessionBuild] => [
              row.id,
              row,
            ]),
          ),
        );
      prune();
    })
    .catch((error) =>
      console.warn("[builds] could not read the snapshot:", error),
    );
  return state.loaded;
}

function prune(): void {
  const cutoff = deps.now() - RETAIN_MS;
  for (const [k, m] of state.merges) if (m.at < cutoff) state.merges.delete(k);
  const endedCutoff = deps.now() - ENDED_RUN_RETAIN_MS;
  for (const [k, r] of state.runs)
    if (r.at < (r.ended ? endedCutoff : cutoff)) state.runs.delete(k);
  for (const [sessionId, rows] of state.rows) {
    for (const [id, row] of rows)
      if (Date.parse(row.updatedAt) < cutoff) rows.delete(id);
    if (!rows.size) state.rows.delete(sessionId);
  }
}

function scheduleSave(): void {
  if (state.saveTimer) return;
  state.saveTimer = deps.setTimer(() => {
    state.saveTimer = null;
    prune();
    const snap = {
      merges: Object.fromEntries(state.merges),
      runs: Object.fromEntries(state.runs),
      rows: Object.fromEntries(
        [...state.rows].map(([id, rows]) => [id, [...rows.values()]]),
      ),
    };
    deps
      .save(JSON.stringify(snap))
      .catch((error) =>
        console.warn("[builds] could not write the snapshot:", error),
      );
  }, SAVE_DEBOUNCE_MS);
}

function flushBroadcasts(): void {
  state.broadcastTimer = null;
  const ids = [...state.dirty];
  state.dirty.clear();
  for (const id of ids) deps.broadcast(id, listRows(id));
}

function markDirty(sessionIds: Iterable<string>): void {
  for (const id of sessionIds) state.dirty.add(id);
  if (!state.broadcastTimer)
    state.broadcastTimer = deps.setTimer(
      flushBroadcasts,
      BROADCAST_DEBOUNCE_MS,
    );
  scheduleSave();
}

function listRows(sessionId: string): SessionBuild[] {
  return [...(state.rows.get(sessionId)?.values() ?? [])].sort((a, b) =>
    b.startedAt.localeCompare(a.startedAt),
  );
}

/** Every build and rollout the session follows, newest first. */
export async function listSessionBuilds(
  sessionId: string,
): Promise<SessionBuild[]> {
  await ensureLoaded();
  return listRows(sessionId);
}

/** Insert or update one row in each session, keeping its first start time. */
function upsert(
  sessionIds: string[],
  row: Omit<SessionBuild, "startedAt" | "updatedAt">,
): void {
  const at = new Date(deps.now()).toISOString();
  for (const sessionId of sessionIds) {
    let rows = state.rows.get(sessionId);
    if (!rows) state.rows.set(sessionId, (rows = new Map()));
    const prev = rows.get(row.id);
    rows.set(row.id, {
      ...row,
      startedAt: prev?.startedAt ?? at,
      updatedAt: at,
    });
    if (rows.size > MAX_ROWS_PER_SESSION) {
      const oldest = [...rows.values()].sort((a, b) =>
        a.updatedAt.localeCompare(b.updatedAt),
      )[0];
      if (oldest) rows.delete(oldest.id);
    }
  }
  markDirty(sessionIds);
}

function removeRow(sessionIds: string[], id: string): void {
  const touched = sessionIds.filter((sessionId) =>
    state.rows.get(sessionId)?.delete(id),
  );
  if (touched.length) markDirty(touched);
}

/** Names and URLs come from other apps; keep them one short line. */
function clean(text: unknown, max = 160): string {
  const value = typeof text === "string" ? text : "";
  const line = value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max - 1)}…` : line;
}

function httpsUrl(value: unknown): string | undefined {
  return typeof value === "string" && /^https:\/\/\S+$/.test(value)
    ? value
    : undefined;
}

async function branchSessions(
  repo: BuildRepo,
  branch: string,
): Promise<string[]> {
  const key = `${repoKey(repo.ghRepo)}:${branch}`;
  const cached = state.branchCache.get(key);
  if (cached && deps.now() - cached.at < BRANCH_CACHE_MS) return cached.ids;
  const ids = await deps.sessionsForBranch(repo.id, branch);
  state.branchCache.set(key, { ids, at: deps.now() });
  if (state.branchCache.size > 500) {
    const cutoff = deps.now() - BRANCH_CACHE_MS;
    for (const [k, v] of state.branchCache)
      if (v.at < cutoff) state.branchCache.delete(k);
  }
  return ids;
}

// ── Webhook intake ──────────────────────────────────────────────────────────

/** A trusted merge of `pr` in `repo`: its merge commit's runs and rollouts
 * belong to the sessions that own the PR's branch. */
export async function recordMergedPr(repo: BuildRepo, pr: any): Promise<void> {
  if (!sessionBuildsEnabled()) return;
  const sha: string = pr?.merge_commit_sha || "";
  const branch: string = pr?.head?.ref || "";
  if (!sha || !branch || typeof pr?.number !== "number") return;
  await ensureLoaded();
  state.branchCache.delete(`${repoKey(repo.ghRepo)}:${branch}`);
  const sessionIds = await branchSessions(repo, branch);
  if (!sessionIds.length) return;
  state.merges.set(mergeKey(repo.ghRepo, sha), {
    sessionIds,
    prNumber: pr.number,
    branch,
    at: deps.now(),
  });
  scheduleSave();
}

function runState(run: any): SessionBuild["state"] | "skipped" {
  if (run.status !== "completed")
    return run.status === "in_progress" ? "running" : "queued";
  switch (run.conclusion) {
    case "success":
    case "neutral":
      return "success";
    case "skipped":
      return "skipped";
    case "cancelled":
    case "stale":
      return "cancelled";
    default:
      return "failure";
  }
}

function jobSummary(run: TrackedRun): {
  jobs?: SessionBuild["jobs"];
  failedDetail?: string;
} {
  const all = Object.values(run.jobs);
  if (!all.length) return {};
  const failed = all.filter((j) => j.failed);
  const first = failed[0];
  return {
    jobs: {
      total: all.length,
      done: all.filter((j) => j.done).length,
      failed: failed.length,
    },
    ...(first
      ? {
          failedDetail: first.failedStep
            ? `${first.name}: ${first.failedStep}`
            : first.name,
        }
      : {}),
  };
}

/** Workflow run requested, started, or completed. Trust is the caller's. */
export async function observeWorkflowRun(
  repo: BuildRepo,
  payload: any,
): Promise<void> {
  if (!sessionBuildsEnabled()) return;
  const run = payload?.workflow_run;
  if (!run || typeof run.id !== "number") return;
  const sha: string = run.head_sha || "";
  const branch: string = run.head_branch || "";
  if (!sha) return;
  await ensureLoaded();

  // Runs started by another event (`workflow_run`, `issue_comment`,
  // `schedule`, ...) report the default branch's head as their commit, so
  // on a merge commit they are other work, not this merge's deploy.
  const merge =
    run.event === "push"
      ? state.merges.get(mergeKey(repo.ghRepo, sha))
      : undefined;
  let sessionIds: string[] = [];
  if (merge) sessionIds = merge.sessionIds;
  else if (
    branch &&
    branch !== (repo.defaultBranch || "main") &&
    // A fork's branch name says nothing about this repository's sessions.
    (!run.head_repository?.full_name ||
      repoKey(run.head_repository.full_name) === repoKey(repo.ghRepo))
  )
    sessionIds = await branchSessions(repo, branch);
  if (!sessionIds.length) return;

  const id = `run:${repoKey(repo.ghRepo)}:${run.id}`;
  const key = runKey(repo.ghRepo, run.id);
  const attempt = Number(run.run_attempt) || 1;
  let tracked = state.runs.get(key);
  if (!tracked || tracked.attempt !== attempt) {
    tracked = { sessionIds, attempt, jobs: {}, at: deps.now() };
    state.runs.set(key, tracked);
  }
  tracked.sessionIds = sessionIds;
  tracked.at = deps.now();

  const status = runState(run);
  const ended = status !== "queued" && status !== "running";
  if (tracked.ended && !ended) return;
  if (ended) tracked.ended = true;
  if (status === "skipped") {
    removeRow(sessionIds, id);
    return;
  }
  const { jobs, failedDetail } = jobSummary(tracked);
  upsert(sessionIds, {
    id,
    kind: "workflow",
    repo: repo.ghRepo,
    title: clean(run.name || run.display_title, 80) || "Workflow",
    state: status,
    ...(status === "failure" && failedDetail
      ? { detail: clean(failedDetail) }
      : {}),
    ...(httpsUrl(run.html_url) ? { url: run.html_url } : {}),
    sha,
    ...(branch ? { branch } : {}),
    ...(merge ? { prNumber: merge.prNumber } : {}),
    ...(jobs ? { jobs } : {}),
    ...(ended ? { endedAt: new Date(deps.now()).toISOString() } : {}),
  });
}

/** One job of a run this module already shows moved. */
export async function observeWorkflowJob(payload: any): Promise<void> {
  if (!sessionBuildsEnabled()) return;
  const job = payload?.workflow_job;
  const ghRepo: string = payload?.repository?.full_name || "";
  if (!job || !ghRepo || typeof job.run_id !== "number") return;
  await ensureLoaded();
  const key = runKey(ghRepo, job.run_id);
  const tracked = state.runs.get(key);
  if (!tracked) return;
  if ((Number(job.run_attempt) || 1) !== tracked.attempt) return;
  const failed = job.status === "completed" && FAILED.has(job.conclusion);
  const failedStep = failed
    ? (job.steps as any[] | undefined)?.find((s) => FAILED.has(s?.conclusion))
        ?.name
    : undefined;
  tracked.jobs[String(job.id)] = {
    name: clean(job.name, 80) || "Job",
    done: job.status === "completed",
    failed,
    ...(failedStep ? { failedStep: clean(failedStep, 80) } : {}),
  };
  tracked.at = deps.now();

  const id = `run:${repoKey(ghRepo)}:${job.run_id}`;
  const { jobs, failedDetail } = jobSummary(tracked);
  const touched: string[] = [];
  const at = new Date(deps.now()).toISOString();
  for (const sessionId of tracked.sessionIds) {
    const rows = state.rows.get(sessionId);
    const row = rows?.get(id);
    if (!rows || !row) continue;
    rows.set(id, {
      ...row,
      ...(jobs ? { jobs } : {}),
      // A failed job is news before the whole run ends.
      ...(failedDetail ? { detail: clean(failedDetail) } : {}),
      ...(row.state === "queued" ? { state: "running" as const } : {}),
      updatedAt: at,
    });
    touched.push(sessionId);
  }
  if (touched.length) markDirty(touched);
}

/** `cd/<target>/<app>` → its target and app, or null for any other context. */
export function parseRolloutContext(
  context: string,
): { target: string; app: string } | null {
  if (!context.startsWith(ROLLOUT_CONTEXT_PREFIX)) return null;
  const parts = context.slice(ROLLOUT_CONTEXT_PREFIX.length).split("/");
  if (parts.length < 2 || parts.some((p) => !p)) return null;
  return { target: parts[0]!, app: parts.slice(1).join("/") };
}

/** A commit status. Only rollout statuses on a remembered merge count. */
export async function observeCommitStatus(
  repo: BuildRepo,
  payload: any,
): Promise<void> {
  if (!sessionBuildsEnabled()) return;
  const context = clean(payload?.context);
  const rollout = parseRolloutContext(context);
  const sha: string = payload?.sha || "";
  if (!rollout || !sha) return;
  await ensureLoaded();
  const merge = state.merges.get(mergeKey(repo.ghRepo, sha));
  if (!merge) return;
  const status: SessionBuild["state"] =
    payload.state === "success"
      ? "success"
      : payload.state === "pending"
        ? "running"
        : "failure";
  const description = clean(payload.description);
  upsert(merge.sessionIds, {
    id: `rollout:${repoKey(repo.ghRepo)}:${sha}:${context}`,
    kind: "rollout",
    repo: repo.ghRepo,
    title: clean(rollout.app, 80),
    target: clean(rollout.target, 80),
    state: status,
    ...(description ? { detail: description } : {}),
    ...(httpsUrl(payload.target_url) ? { url: payload.target_url } : {}),
    sha,
    branch: merge.branch,
    prNumber: merge.prNumber,
    ...(status !== "running"
      ? { endedAt: new Date(deps.now()).toISOString() }
      : {}),
  });
}

/** Whether a commit status could be a rollout, before any lookup: statuses
 * arrive by the hundred an hour. */
export function mayBeRolloutStatus(payload: any): boolean {
  return (
    typeof payload?.context === "string" &&
    payload.context.startsWith(ROLLOUT_CONTEXT_PREFIX)
  );
}
