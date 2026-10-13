import { expect, test } from "bun:test";
import { mergeChoices } from "./merge-choices";

const open = {
  state: "OPEN" as const,
  isDraft: false,
  mergeable: "MERGEABLE",
  mergeStateStatus: "CLEAN",
  reviewDecision: "APPROVED",
  autoMerge: null,
};
const github = { autoMerge: true, forceMerge: true };
const clear = { failed: 0, pending: 0 };

test("a clean PR offers only a plain merge", () => {
  expect(mergeChoices(open, clear, github)).toEqual({
    primary: "merge",
    all: ["merge"],
    bypasses: [],
  });
});

test("running checks keep merge first and add auto-merge and force merge", () => {
  const choices = mergeChoices(
    { ...open, mergeStateStatus: "UNSTABLE" },
    { failed: 0, pending: 2 },
    github,
  );
  expect(choices.primary).toBe("merge");
  expect(choices.all).toEqual(["merge", "auto", "force"]);
  expect(choices.bypasses).toEqual(["2 running checks"]);
});

test("a blocked PR leads with auto-merge and names what force merge bypasses", () => {
  const choices = mergeChoices(
    {
      ...open,
      mergeStateStatus: "BLOCKED",
      reviewDecision: "REVIEW_REQUIRED",
    },
    { failed: 1, pending: 0 },
    github,
  );
  expect(choices.primary).toBe("auto");
  expect(choices.all).toEqual(["auto", "force"]);
  expect(choices.bypasses).toEqual(["1 failing check", "a required review"]);
});

test("auto-merge already on offers cancel instead", () => {
  const choices = mergeChoices(
    {
      ...open,
      mergeStateStatus: "BLOCKED",
      autoMerge: { method: "squash", enabledBy: "acme" },
    },
    clear,
    github,
  );
  expect(choices.all).toEqual(["cancel-auto", "force"]);
  expect(choices.primary).toBeNull();
  expect(choices.bypasses).toEqual(["branch protection"]);
});

test("drafts, conflicts and closed PRs offer nothing", () => {
  for (const pr of [
    { ...open, isDraft: true },
    { ...open, mergeable: "CONFLICTING" },
    { ...open, state: "MERGED" as const },
  ])
    expect(mergeChoices(pr, clear, github).all).toEqual([]);
});

test("hosts without auto-merge or force merge keep the plain merge", () => {
  const choices = mergeChoices(
    { ...open, mergeStateStatus: "UNSTABLE" },
    { failed: 0, pending: 1 },
    { autoMerge: false, forceMerge: false },
  );
  expect(choices.all).toEqual(["merge"]);
});
