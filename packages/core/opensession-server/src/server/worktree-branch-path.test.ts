import { expect, test } from "bun:test";
import { worktreeDirNameForBranch } from "./worktree";

test("flattens slash-containing branch names for the checkout directory", () => {
  expect(worktreeDirNameForBranch("eng/247/add-oauth-flow")).toBe(
    "eng~247~add-oauth-flow",
  );
  expect(worktreeDirNameForBranch("feature/one/two")).toBe("feature~one~two");
});

test("leaves slash-free branch names unchanged", () => {
  expect(worktreeDirNameForBranch("fix-the-bug")).toBe("fix-the-bug");
});

test("flattened names cannot collide with a valid git branch name", () => {
  // `~` is forbidden in git refs, so `a/b` cannot share a directory with `a-b`.
  expect(worktreeDirNameForBranch("a/b")).not.toBe(
    worktreeDirNameForBranch("a-b"),
  );
});
