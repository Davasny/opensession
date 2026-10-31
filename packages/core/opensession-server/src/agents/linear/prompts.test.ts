import { expect, test } from "bun:test";
import { IMPLEMENTATION_PROMPT } from "./prompts";

test("implementation pushes set an upstream for the automatic PR", () => {
  // A fresh Linear worktree branch has no upstream. Plain `git push` fails,
  // and `gh pr create` then has no pushed head to open the PR from.
  expect(IMPLEMENTATION_PROMPT).toContain("git push -u origin HEAD");
  // PR creation stays automatic; the model must not open its own.
  expect(IMPLEMENTATION_PROMPT).toContain("Do NOT create a PR");
});
