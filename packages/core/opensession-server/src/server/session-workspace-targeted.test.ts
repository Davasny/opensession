/**
 * Creation-time workspace filing against the real catalog/projection path.
 * No list scan, no test-only early return: the writer must mint or adopt a
 * workspace, write the session sidecar, and publish the warm index row.
 */
import { afterEach, beforeEach, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "linear-workspace-targeted-"));
process.env.OPENSESSION_STATE_DIR = dir;

const { SessionKernelStore, __setSessionKernelStoreForTest } =
  await import("./session-kernel");
const { __resetWorkspaceProjectionForTest, createWorkspace, listWorkspaces } =
  await import("./workspaces");
const { fileSessionWorkspace } = await import("./session-workspace");
const { SESSIONS_DIR } = await import("./session-cache");
const { indexedSession } = await import("./session-list-store");
const { defaultRepo } = await import("./config");

let store: InstanceType<typeof SessionKernelStore>;
let previous: InstanceType<typeof SessionKernelStore> | undefined;

beforeEach(() => {
  process.env.OPENSESSION_STATE_DIR = dir;
  store = new SessionKernelStore(":memory:");
  previous = __setSessionKernelStoreForTest(store);
  __resetWorkspaceProjectionForTest();
});

afterEach(() => {
  __setSessionKernelStoreForTest(previous);
  store.close();
  __resetWorkspaceProjectionForTest();
});

function linearSource(sessionId: string, branch: string, title: string): void {
  const key = sessionId.slice("linear-".length);
  mkdirSync(join(dir, ".linear-sessions"), { recursive: true });
  writeFileSync(
    join(dir, ".linear-sessions", `${key}.json`),
    JSON.stringify({
      branch,
      linearSessionId: key.slice("agent~".length),
      issueIdentifier: "ENG-1",
      issueTitle: title,
      issueCreator: { id: "u1", name: "Ada", email: "ada@example.test" },
      worktreeDir: `/tmp/${branch}`,
      updatedAt: new Date().toISOString(),
    }),
  );
}

test("mints, links and publishes a warm row for one session", async () => {
  const sessionId = "linear-agent~targeted-one";
  linearSource(sessionId, "targeted-branch", "Fix the target");

  const workspace = await fileSessionWorkspace({
    sessionId,
    repo: defaultRepo().id,
    branch: "targeted-branch",
    worktreeDir: "/tmp/targeted-branch",
    ownsWorktree: true,
    title: "ENG-1: Fix the target",
    createdBy: "Ada",
    createdAt: "2026-10-01T10:00:00.000Z",
  });

  expect(workspace).toMatchObject({
    repo: defaultRepo().id,
    branch: "targeted-branch",
    worktreeDir: "/tmp/targeted-branch",
    createdBy: "Ada",
  });
  const sidecar = JSON.parse(
    readFileSync(join(SESSIONS_DIR, `${sessionId}.json`), "utf8"),
  );
  expect(sidecar.workspaceId).toBe(workspace!.id);
  expect(await indexedSession(sessionId)).toMatchObject({
    id: sessionId,
    workspaceId: workspace!.id,
  });

  const again = await fileSessionWorkspace({
    sessionId,
    repo: defaultRepo().id,
    branch: "targeted-branch",
    worktreeDir: "/tmp/targeted-branch",
    ownsWorktree: true,
    title: "ENG-1: Fix the target",
    createdBy: "Ada",
  });
  expect(again?.id).toBe(workspace!.id);
  expect(
    (await listWorkspaces()).filter((w) => w.branch === "targeted-branch"),
  ).toHaveLength(1);
});

test("concurrent distinct sessions on one branch share the workspace and both link", async () => {
  const firstId = "linear-agent~concurrent-one";
  const secondId = "linear-agent~concurrent-two";
  linearSource(firstId, "concurrent-branch", "Concurrent one");
  linearSource(secondId, "concurrent-branch", "Concurrent two");
  const base = {
    repo: defaultRepo().id,
    branch: "concurrent-branch",
    worktreeDir: "/tmp/concurrent-branch",
    ownsWorktree: true,
    createdBy: "Ada",
  };

  const [first, second] = await Promise.all([
    fileSessionWorkspace({
      ...base,
      sessionId: firstId,
      title: "ENG-1: Concurrent one",
    }),
    fileSessionWorkspace({
      ...base,
      sessionId: secondId,
      title: "ENG-1: Concurrent two",
    }),
  ]);
  expect(first?.id).toBe(second?.id);
  expect(await indexedSession(firstId)).toMatchObject({
    workspaceId: first!.id,
  });
  expect(await indexedSession(secondId)).toMatchObject({
    workspaceId: second!.id,
  });
  expect(
    (await listWorkspaces()).filter((w) => w.branch === "concurrent-branch"),
  ).toHaveLength(1);
});

test("does not link an ended session", async () => {
  const sessionId = "linear-agent~ended-filing";
  linearSource(sessionId, "ended-branch", "Ended target");
  const result = await fileSessionWorkspace({
    sessionId,
    repo: defaultRepo().id,
    branch: "ended-branch",
    worktreeDir: "/tmp/ended-branch",
    ownsWorktree: true,
    title: "ENG-1: Ended target",
    createdBy: "Ada",
    isLive: () => false,
  });
  expect(result).toBeNull();
  expect(await indexedSession(sessionId)).toBeNull();
});

test("shared checkouts get distinct workspaces even on the same branch", async () => {
  const firstId = "linear-agent~shared-one";
  const secondId = "linear-agent~shared-two";
  linearSource(firstId, "main", "Shared one");
  linearSource(secondId, "main", "Shared two");
  const base = {
    repo: defaultRepo().id,
    branch: "main",
    worktreeDir: "/tmp/shared-checkout",
    ownsWorktree: false,
    createdBy: "Ada",
  };

  const first = await fileSessionWorkspace({
    ...base,
    sessionId: firstId,
    title: "ENG-1: Shared one",
  });
  const second = await fileSessionWorkspace({
    ...base,
    sessionId: secondId,
    title: "ENG-1: Shared two",
  });
  expect(first?.id).not.toBe(second?.id);
});

test("adopts an existing workspace by worktree before minting", async () => {
  const sessionId = "linear-agent~targeted-three";
  linearSource(sessionId, "adopt-branch", "Adopt target");
  const existing = await createWorkspace({
    name: "Existing workspace",
    repo: defaultRepo().id,
    branch: "adopt-branch",
    worktreeDir: "/tmp/adopt-branch",
    createdBy: "Ada",
  });

  const workspace = await fileSessionWorkspace({
    sessionId,
    repo: defaultRepo().id,
    branch: "adopt-branch",
    worktreeDir: "/tmp/adopt-branch",
    ownsWorktree: true,
    title: "ENG-1: Adopt target",
    createdBy: "Ada",
  });
  expect(workspace?.id).toBe(existing.id);
  expect(
    (await listWorkspaces()).filter(
      (w) => w.worktreeDir === "/tmp/adopt-branch",
    ),
  ).toHaveLength(1);
});
