import { expect, test } from "bun:test";
import { IMPLEMENTATION_PROMPT } from "./prompts";
import {
  LINEAR_IMPLEMENTATION_COMPLETE,
  PR_BODY_SENTINEL,
} from "../../server/pr-body";

test("implementation pushes set an upstream for the automatic PR", () => {
  // A fresh Linear worktree branch has no upstream. Plain `git push` fails,
  // and `gh pr create` then has no pushed head to open the PR from.
  expect(IMPLEMENTATION_PROMPT).toContain("git push -u origin HEAD");
  // PR creation stays automatic; the model must not open its own.
  expect(IMPLEMENTATION_PROMPT).toContain("Do NOT create a PR");
});

test("implementation asks for a reviewer-facing PR description", () => {
  expect(IMPLEMENTATION_PROMPT).toContain(PR_BODY_SENTINEL);
  expect(IMPLEMENTATION_PROMPT).toContain(LINEAR_IMPLEMENTATION_COMPLETE);
  expect(IMPLEMENTATION_PROMPT).toContain("full pull request description");
  expect(IMPLEMENTATION_PROMPT).toContain("as if the repository is public");
});
