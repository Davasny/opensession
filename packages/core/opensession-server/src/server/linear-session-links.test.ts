/**
 * Linear sessions are addressed by their store file key, not their branch.
 * A legacy branch-named file keeps its old `linear-<branch>` deep link; a
 * current agent-session-named file gets its own `linear-<id>` row. Both must
 * resolve to their own worktree, and an engine-id sync must patch only the file
 * behind the unified id.
 */
import { expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME!;
const LINEAR_DIR = join(HOME, ".linear-sessions");
const SHARED_BRANCH = "fix-the-eng1";
const LEGACY_ID = "44444444-4444-4444-8444-444444444444";
const CURRENT_ID = "55555555-5555-4555-8555-555555555555";
const CURRENT_KEY = `agent~${CURRENT_ID}`;

mkdirSync(LINEAR_DIR, { recursive: true });
writeFileSync(
  join(LINEAR_DIR, `${SHARED_BRANCH}.json`),
  JSON.stringify({
    branch: SHARED_BRANCH,
    worktreeDir: "/tmp/linear-legacy-worktree",
    claudeSessionId: "engine-legacy",
    linearSessionId: LEGACY_ID,
    issueIdentifier: "ENG-1",
    issueTitle: "Fix the bug",
    issueUrl: "https://linear.app/example/issue/ENG-1",
    updatedAt: "2026-10-01T10:00:00.000Z",
  }),
);
writeFileSync(
  join(LINEAR_DIR, `${CURRENT_KEY}.json`),
  JSON.stringify({
    branch: `${SHARED_BRANCH}-2`,
    worktreeDir: "/tmp/linear-current-worktree",
    claudeSessionId: "engine-current",
    linearSessionId: CURRENT_ID,
    issueIdentifier: "ENG-1",
    issueTitle: "Fix the bug",
    issueUrl: "https://linear.app/example/issue/ENG-1",
    updatedAt: "2026-10-02T10:00:00.000Z",
  }),
);

test("old branch links and current agent-session ids resolve to their own rows", async () => {
  const { readAgentSessionListRow } = await import(
    `./sessions.ts?linear-links=${crypto.randomUUID()}`
  );

  const legacy = readAgentSessionListRow(`linear-${SHARED_BRANCH}`);
  expect(legacy).toMatchObject({
    id: `linear-${SHARED_BRANCH}`,
    source: "linear",
    branch: SHARED_BRANCH,
    worktreeDir: "/tmp/linear-legacy-worktree",
    linearSessionId: LEGACY_ID,
    claudeSessionId: "engine-legacy",
  });

  const current = readAgentSessionListRow(`linear-${CURRENT_KEY}`);
  expect(current).toMatchObject({
    id: `linear-${CURRENT_KEY}`,
    source: "linear",
    branch: `${SHARED_BRANCH}-2`,
    worktreeDir: "/tmp/linear-current-worktree",
    linearSessionId: CURRENT_ID,
    claudeSessionId: "engine-current",
    linearIssue: { identifier: "ENG-1", title: "Fix the bug" },
  });
  // The current row is not addressed by its branch, even though the old row
  // still owns the shared branch name.
  expect(readAgentSessionListRow(`linear-${SHARED_BRANCH}`)?.id).not.toBe(
    current?.id,
  );
  expect(readAgentSessionListRow("linear-agent~missing")).toBeUndefined();
});

test("engine-id sync patches only the file behind the unified id", async () => {
  const { syncAgentSessionEngine } = await import("./agent-session-sync");
  const { isLinearSessionTerminal, markLinearSessionTerminal } =
    await import("../agents/linear/session-store");

  const currentRow = {
    id: `linear-${CURRENT_KEY}`,
    source: "linear" as const,
    branch: SHARED_BRANCH,
    linearSessionId: CURRENT_ID,
  };
  expect(
    await syncAgentSessionEngine(currentRow, {
      engineSessionId: "engine-synced",
    }),
  ).toBe(true);

  const current = JSON.parse(
    readFileSync(join(LINEAR_DIR, `${CURRENT_KEY}.json`), "utf8"),
  );
  const legacy = JSON.parse(
    readFileSync(join(LINEAR_DIR, `${SHARED_BRANCH}.json`), "utf8"),
  );
  expect(current.claudeSessionId).toBe("engine-synced");
  expect(legacy.claudeSessionId).toBe("engine-legacy");

  // A sync carrying another agent-session id must not patch an owned file.
  expect(
    await syncAgentSessionEngine(
      {
        ...currentRow,
        linearSessionId: "99999999-9999-4999-8999-999999999999",
      },
      { engineSessionId: "engine-wrong-id" },
    ),
  ).toBe(false);
  expect(
    JSON.parse(readFileSync(join(LINEAR_DIR, `${CURRENT_KEY}.json`), "utf8"))
      .claudeSessionId,
  ).toBe("engine-synced");

  // Legacy branch rows carry their old id; a branch-shaped id must not patch
  // a file owned by a different agent session.
  expect(
    await syncAgentSessionEngine(
      {
        id: `linear-${SHARED_BRANCH}`,
        source: "linear",
        branch: SHARED_BRANCH,
        linearSessionId: "99999999-9999-4999-8999-999999999999",
      },
      { engineSessionId: "engine-legacy-wrong" },
    ),
  ).toBe(false);

  // Terminal state blocks the sync that could otherwise recreate a record.
  await markLinearSessionTerminal(CURRENT_ID);
  expect(await isLinearSessionTerminal(CURRENT_ID)).toBe(true);
  expect(
    await syncAgentSessionEngine(currentRow, {
      engineSessionId: "engine-after-end",
    }),
  ).toBe(false);
  expect(
    JSON.parse(readFileSync(join(LINEAR_DIR, `${CURRENT_KEY}.json`), "utf8"))
      .claudeSessionId,
  ).toBe("engine-synced");
});
