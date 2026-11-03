import { expect, test } from "bun:test";
import { branchNameFromIssue, legacyBranchName } from "./session";

test("uses Linear's branch name verbatim", () => {
  expect(
    branchNameFromIssue("eng/247/add-oauth-flow", "Add OAuth", "ENG-247"),
  ).toBe("eng/247/add-oauth-flow");
  expect(branchNameFromIssue("ENG-247-Add-OAuth", "Add OAuth", "ENG-247")).toBe(
    "ENG-247-Add-OAuth",
  );
});

test("falls back to the legacy name when Linear returns nothing usable", () => {
  const fallback = legacyBranchName("Fix the login bug", "ENG-247");
  expect(fallback).toBe("fix-the-eng247");

  for (const branchName of [
    undefined,
    "",
    "   ",
    "-leading-dash",
    "has spaces",
    "double..dot",
    "/leading-slash",
    "trailing/",
    "component/.dot",
    "component.lock/child",
    "trailing.",
    "release.lock",
    "parent@{ref",
    "x".repeat(201),
  ]) {
    expect(
      branchNameFromIssue(branchName, "Fix the login bug", "ENG-247"),
    ).toBe(fallback);
  }
});

test("legacyBranchName still matches the pre-Linear heuristic", () => {
  expect(legacyBranchName("Fix the bug", "ENG-1")).toBe("fix-the-eng1");
  expect(legacyBranchName("", undefined)).toBe("task");
});
