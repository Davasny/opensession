import { expect, test } from "bun:test";
import {
  addReviewClaim,
  beginReviewRound,
  MAX_REVIEW_CLAIMS,
  reviewClaimSeen,
  reviewRoundCount,
  setReviewClaimStatus,
  type StoredSession,
} from "./session";

function session(): StoredSession {
  return {
    branch: "fix-the-eng1",
    claudeSessionId: null,
    issueIdentifier: "ENG-1",
    issueTitle: "Fix the bug",
    worktreeDir: "/synthetic-worktrees/fix-the-eng1",
    linearSessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    phase: "working",
    issueId: "issue-1",
    issueUrl: "https://linear.app/acme/issue/ENG-1",
    participants: [],
    lastActiveUser: null,
    issueCreator: null,
  };
}

test("claims dedupe by review id and start pending", () => {
  const state = session();
  addReviewClaim(state, "review-1", "sha-1");
  addReviewClaim(state, "review-1", "sha-1");
  expect(reviewClaimSeen(state, "review-1")).toBe(true);
  expect(state.reviewAutostart?.claims).toHaveLength(1);
  expect(state.reviewAutostart?.claims[0]).toMatchObject({
    reviewId: "review-1",
    sha: "sha-1",
    status: "pending",
  });
});

test("rounds count dispatched turns, not queued reviews", () => {
  const state = session();
  addReviewClaim(state, "review-1", "sha-1");
  expect(reviewRoundCount(state)).toBe(0);
  beginReviewRound(state);
  beginReviewRound(state);
  expect(reviewRoundCount(state)).toBe(2);
  expect(state.reviewAutostart?.deliveredAt).toBeString();
});

test("settled claims record when they finished", () => {
  const state = session();
  addReviewClaim(state, "review-1", "sha-1");
  addReviewClaim(state, "review-2", "sha-2");
  setReviewClaimStatus(state, ["review-1"], "completed");
  setReviewClaimStatus(state, ["review-2"], "dispatched");
  expect(state.reviewAutostart?.claims[0]).toMatchObject({
    status: "completed",
  });
  expect(state.reviewAutostart?.claims[0].settledAt).toBeString();
  expect(state.reviewAutostart?.claims[1]).toMatchObject({
    status: "dispatched",
  });
  expect(state.reviewAutostart?.claims[1].settledAt).toBeUndefined();
});

test("the claim list stays bounded", () => {
  const state = session();
  for (let index = 0; index < MAX_REVIEW_CLAIMS + 5; index++)
    addReviewClaim(state, `review-${index}`, `sha-${index}`);
  const claims = state.reviewAutostart?.claims ?? [];
  expect(claims).toHaveLength(MAX_REVIEW_CLAIMS);
  expect(claims[claims.length - 1].reviewId).toBe(
    `review-${MAX_REVIEW_CLAIMS + 4}`,
  );
});
