import { beforeEach, describe, expect, test } from "bun:test";
import {
  __flushSessionBuildsForTest,
  __resetSessionBuildsForTest,
  listSessionBuilds,
  observeCommitStatus,
  observeWorkflowJob,
  observeWorkflowRun,
  parseRolloutContext,
  recordMergedPr,
  type SessionBuild,
} from "./session-builds";

const repo = { id: "acme", ghRepo: "acme/app", defaultBranch: "main" };
let owners: Record<string, string[]>;
let frames: Array<{ sessionId: string; builds: SessionBuild[] }>;
let lookups: number;
let clock: number;

beforeEach(() => {
  owners = { "feature-x": ["s1"] };
  frames = [];
  lookups = 0;
  clock = Date.parse("2026-10-14T10:00:00Z");
  __resetSessionBuildsForTest({
    sessionsForBranch: async (_repo, branch) => {
      lookups++;
      return owners[branch] ?? [];
    },
    broadcast: (sessionId, builds) => frames.push({ sessionId, builds }),
    load: async () => null,
    save: async () => {},
    now: () => clock,
    setTimer: () => 1,
  });
});

function run(overrides: Record<string, unknown> = {}) {
  return {
    action: "in_progress",
    workflow_run: {
      id: 7,
      name: "CI",
      event: "push",
      status: "in_progress",
      conclusion: null,
      html_url: "https://github.com/acme/app/actions/runs/7",
      head_branch: "feature-x",
      head_sha: "a".repeat(40),
      run_attempt: 1,
      head_repository: { full_name: "acme/app" },
      ...overrides,
    },
  };
}

describe("session builds", () => {
  test("a run on the session's branch shows, then ends", async () => {
    await observeWorkflowRun(repo, run());
    expect((await listSessionBuilds("s1"))[0]).toMatchObject({
      kind: "workflow",
      title: "CI",
      state: "running",
      branch: "feature-x",
    });
    await observeWorkflowJob({
      repository: { full_name: "acme/app" },
      workflow_job: {
        id: 1,
        run_id: 7,
        run_attempt: 1,
        name: "test",
        status: "completed",
        conclusion: "failure",
        steps: [
          { name: "Install", conclusion: "success" },
          { name: "Run tests", conclusion: "failure" },
        ],
      },
    });
    await observeWorkflowRun(
      repo,
      run({ status: "completed", conclusion: "failure" }),
    );
    const [row] = await listSessionBuilds("s1");
    expect(row).toMatchObject({
      state: "failure",
      detail: "test: Run tests",
      jobs: { total: 1, done: 1, failed: 1 },
    });
    expect(row!.endedAt).toBeDefined();
    __flushSessionBuildsForTest();
    expect(frames.map((f) => f.sessionId)).toEqual(["s1"]);
  });

  test("default branch, fork, and unowned runs show nowhere", async () => {
    await observeWorkflowRun(repo, run({ head_branch: "main" }));
    await observeWorkflowRun(
      repo,
      run({ head_repository: { full_name: "someone/app" } }),
    );
    await observeWorkflowRun(repo, run({ head_branch: "nobody" }));
    expect(await listSessionBuilds("s1")).toEqual([]);
  });

  test("skipped runs are dropped and the branch lookup is cached", async () => {
    await observeWorkflowRun(repo, run());
    await observeWorkflowRun(
      repo,
      run({ status: "completed", conclusion: "skipped" }),
    );
    expect(await listSessionBuilds("s1")).toEqual([]);
    expect(lookups).toBe(1);
  });

  test("a start delivered after the end does not revive the run", async () => {
    await observeWorkflowRun(
      repo,
      run({ status: "completed", conclusion: "skipped" }),
    );
    await observeWorkflowRun(repo, run());
    expect(await listSessionBuilds("s1")).toEqual([]);

    await observeWorkflowRun(
      repo,
      run({ id: 8, status: "completed", conclusion: "success" }),
    );
    await observeWorkflowRun(repo, run({ id: 8 }));
    expect(await listSessionBuilds("s1")).toMatchObject([{ state: "success" }]);

    // A rerun is a new attempt and runs again.
    await observeWorkflowRun(repo, run({ id: 8, run_attempt: 2 }));
    expect(await listSessionBuilds("s1")).toMatchObject([{ state: "running" }]);
  });

  test("only the merge's own push runs join its deploy", async () => {
    const merge = "b".repeat(40);
    await recordMergedPr(repo, {
      number: 12,
      merge_commit_sha: merge,
      head: { ref: "feature-x" },
    });
    for (const [id, event] of [
      [20, "workflow_run"],
      [21, "issue_comment"],
      [22, "schedule"],
    ] as const)
      await observeWorkflowRun(
        repo,
        run({ id, event, head_branch: "main", head_sha: merge }),
      );
    expect(await listSessionBuilds("s1")).toEqual([]);
  });

  test("a merge carries its deploy run and rollouts into the session", async () => {
    const merge = "b".repeat(40);
    await recordMergedPr(repo, {
      number: 12,
      merge_commit_sha: merge,
      head: { ref: "feature-x" },
    });
    await observeWorkflowRun(
      repo,
      run({ id: 9, name: "Deploy", head_branch: "main", head_sha: merge }),
    );
    await observeCommitStatus(repo, {
      sha: merge,
      context: "cd/prod/web",
      state: "pending",
      description: "web is deploying to prod",
      target_url: "https://cd.example.test/applications/web",
    });
    clock += 60_000;
    await observeCommitStatus(repo, {
      sha: merge,
      context: "cd/prod/web",
      state: "success",
      description: "web deployed to prod",
      target_url: "https://cd.example.test/applications/web",
    });
    // Not a rollout context, and not a tracked commit.
    await observeCommitStatus(repo, {
      sha: merge,
      context: "lint",
      state: "success",
    });
    await observeCommitStatus(repo, {
      sha: "c".repeat(40),
      context: "cd/prod/web",
      state: "success",
    });
    const rows = await listSessionBuilds("s1");
    expect(rows).toHaveLength(2);
    const rollout = rows.find((r) => r.kind === "rollout")!;
    expect(rollout).toMatchObject({
      title: "web",
      target: "prod",
      state: "success",
      prNumber: 12,
      detail: "web deployed to prod",
    });
    expect(rollout.startedAt < rollout.updatedAt).toBe(true);
    expect(rows.find((r) => r.kind === "workflow")).toMatchObject({
      title: "Deploy",
      prNumber: 12,
    });
  });

  test("parses rollout contexts", () => {
    expect(parseRolloutContext("cd/prod-1/api")).toEqual({
      target: "prod-1",
      app: "api",
    });
    expect(parseRolloutContext("cd/prod")).toBeNull();
    expect(parseRolloutContext("ci/prod/api")).toBeNull();
  });
});

describe("session builds snapshot", () => {
  test("drops an ended run an hour after it ends, keeps an open one", async () => {
    const saved: string[] = [];
    let timers: Array<() => void> = [];
    const fire = async () => {
      const due = timers;
      timers = [];
      for (const fn of due) fn();
      await Promise.resolve();
    };
    __resetSessionBuildsForTest({
      sessionsForBranch: async (_repo, branch) => owners[branch] ?? [],
      broadcast: () => {},
      load: async () => null,
      save: async (json) => {
        saved.push(json);
      },
      now: () => clock,
      setTimer: (fn) => {
        timers.push(fn);
        return 1;
      },
    });
    await observeWorkflowRun(repo, run({ id: 1 }));
    await observeWorkflowRun(
      repo,
      run({ id: 2, status: "completed", conclusion: "success" }),
    );
    await fire();
    expect(Object.keys(JSON.parse(saved.at(-1)!).runs).sort()).toEqual([
      "acme/app#1",
      "acme/app#2",
    ]);

    clock += 61 * 60_000;
    // Any change schedules the next save, which prunes first.
    await observeWorkflowRun(
      repo,
      run({ id: 3, status: "completed", conclusion: "success" }),
    );
    await fire();
    expect(Object.keys(JSON.parse(saved.at(-1)!).runs).sort()).toEqual([
      "acme/app#1",
      "acme/app#3",
    ]);
  });
});
