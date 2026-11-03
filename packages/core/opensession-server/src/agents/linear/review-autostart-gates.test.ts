import { describe, expect, test } from "bun:test";
import {
  reviewClaimDecision,
  reviewTriggerDecision,
  type ReviewTriggerFacts,
} from "./review-autostart-gates";

function facts(
  overrides: Partial<ReviewTriggerFacts> = {},
): ReviewTriggerFacts {
  return {
    event: "pull_request_review",
    action: "submitted",
    state: "CHANGES_REQUESTED",
    draft: false,
    prState: "open",
    merged: false,
    reviewerLogin: "alice",
    reviewerIsBot: false,
    reviewerIsTrusted: true,
    prAuthorLogin: "os-bot[bot]",
    ...overrides,
  };
}

describe("reviewTriggerDecision", () => {
  test("starts on a trusted changes-requested review", () => {
    expect(reviewTriggerDecision(facts(), { reviewers: "trusted" })).toEqual({
      start: true,
    });
  });

  test("ignores approvals, comments and edits", () => {
    for (const state of ["APPROVED", "COMMENTED", "DISMISSED"]) {
      expect(
        reviewTriggerDecision(facts({ state }), { reviewers: "trusted" }),
      ).toMatchObject({ start: false, reason: "state" });
    }
    expect(
      reviewTriggerDecision(facts({ action: "edited" }), {
        reviewers: "trusted",
      }),
    ).toMatchObject({ start: false, reason: "action" });
  });

  test("ignores closed, merged and draft pull requests", () => {
    expect(
      reviewTriggerDecision(facts({ prState: "closed" }), {
        reviewers: "trusted",
      }),
    ).toMatchObject({ start: false, reason: "pr-state" });
    expect(
      reviewTriggerDecision(facts({ merged: true }), { reviewers: "trusted" }),
    ).toMatchObject({ start: false, reason: "merged" });
    expect(
      reviewTriggerDecision(facts({ draft: true }), { reviewers: "trusted" }),
    ).toMatchObject({ start: false, reason: "draft" });
  });

  test("rejects bots, self-reviews and anonymous reviewers", () => {
    expect(
      reviewTriggerDecision(facts({ reviewerIsBot: true }), {
        reviewers: "any-write",
      }),
    ).toMatchObject({ start: false, reason: "bot" });
    expect(
      reviewTriggerDecision(
        facts({ reviewerLogin: "Alice", prAuthorLogin: "alice" }),
        { reviewers: "any-write" },
      ),
    ).toMatchObject({ start: false, reason: "author" });
    expect(
      reviewTriggerDecision(facts({ reviewerLogin: " " }), {
        reviewers: "any-write",
      }),
    ).toMatchObject({ start: false, reason: "anonymous-reviewer" });
  });

  test("trusted mode rejects non-roster reviewers", () => {
    expect(
      reviewTriggerDecision(facts({ reviewerIsTrusted: false }), {
        reviewers: "trusted",
      }),
    ).toMatchObject({ start: false, reason: "untrusted" });
    expect(
      reviewTriggerDecision(facts({ reviewerIsTrusted: false }), {
        reviewers: "any-write",
      }),
    ).toEqual({ start: true });
  });
});

describe("reviewClaimDecision", () => {
  const claims = [{ reviewId: "1" }, { reviewId: "2" }];

  test("accepts a new review under the cap", () => {
    expect(reviewClaimDecision(claims, "3", 2, 4)).toBe("start");
  });

  test("deduplicates a claimed review id", () => {
    expect(reviewClaimDecision(claims, "2", 2, 4)).toBe("duplicate");
  });

  test("stops at the round cap", () => {
    expect(reviewClaimDecision(claims, "3", 4, 4)).toBe("capped");
  });
});
