/**
 * Pure decisions for starting a Linear fix turn from a GitHub review.
 *
 * Zero imports (like the GitHub agent's handoff gates) so the tests can load
 * this file without dragging in the runner, config, or catalog.
 */

export type ReviewTrustMode = "trusted" | "any-write";

export interface ReviewTriggerFacts {
  event: string;
  action: string;
  /** Uppercase GitHub review state: CHANGES_REQUESTED, APPROVED, COMMENTED. */
  state: string;
  draft: boolean;
  /** Lowercase pull request state: open or closed. */
  prState: string;
  merged: boolean;
  reviewerLogin: string;
  reviewerIsBot: boolean;
  reviewerIsTrusted: boolean;
  prAuthorLogin: string;
}

export interface ReviewTriggerOptions {
  reviewers: ReviewTrustMode;
}

export type ReviewTriggerDecision =
  | { start: true }
  | { start: false; reason: string };

/**
 * Whether this delivery should start a fix turn. `any-write` still rejects
 * bots, the PR author, and empty logins; GitHub has already decided that the
 * account could submit a review.
 */
export function reviewTriggerDecision(
  facts: ReviewTriggerFacts,
  options: ReviewTriggerOptions,
): ReviewTriggerDecision {
  if (facts.event !== "pull_request_review") return skip("event");
  if (facts.action !== "submitted") return skip("action");
  if (facts.state !== "CHANGES_REQUESTED") return skip("state");
  if (facts.draft) return skip("draft");
  if (facts.prState !== "open") return skip("pr-state");
  if (facts.merged) return skip("merged");
  if (!facts.reviewerLogin.trim()) return skip("anonymous-reviewer");
  if (facts.reviewerIsBot) return skip("bot");
  const reviewer = facts.reviewerLogin.toLowerCase();
  if (reviewer === facts.prAuthorLogin.toLowerCase()) return skip("author");
  if (options.reviewers === "trusted" && !facts.reviewerIsTrusted)
    return skip("untrusted");
  return { start: true };
}

function skip(reason: string): ReviewTriggerDecision {
  return { start: false, reason };
}

export type ReviewClaimDecision = "start" | "duplicate" | "capped";

/** A review id is claimed at most once; the round cap bounds the loop. */
export function reviewClaimDecision(
  claims: ReadonlyArray<{ reviewId: string }>,
  reviewId: string,
  rounds: number,
  cap: number,
): ReviewClaimDecision {
  if (claims.some((claim) => claim.reviewId === reviewId)) return "duplicate";
  if (rounds >= cap) return "capped";
  return "start";
}
