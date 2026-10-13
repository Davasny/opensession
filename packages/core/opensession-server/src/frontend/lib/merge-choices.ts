import type { PrDetails, PrHostCapabilities } from "./types";

/**
 * The ways the Review tab can land an open PR:
 * - `merge`: squash and merge now.
 * - `auto`: turn on auto-merge, so the host squashes it once checks and
 *   reviews pass.
 * - `cancel-auto`: turn auto-merge back off.
 * - `force`: squash and merge past branch protection with the viewer's own
 *   rights. The host decides whether they have them.
 */
export type MergeChoice = "merge" | "auto" | "cancel-auto" | "force";

export const MERGE_CHOICE_LABEL: Record<MergeChoice, string> = {
  merge: "Squash and merge",
  auto: "Merge when ready",
  "cancel-auto": "Cancel auto-merge",
  force: "Force merge",
};

/** Short labels for the status row's own button. */
export const MERGE_CHOICE_SHORT: Record<MergeChoice, string> = {
  merge: "Merge",
  auto: "Auto-merge",
  "cancel-auto": "Cancel",
  force: "Force merge",
};

export const MERGE_CHOICE_TITLE: Record<MergeChoice, string> = {
  merge: "Squash and merge this pull request",
  auto: "Squash and merge automatically once checks and reviews pass",
  "cancel-auto": "Stop merging this pull request automatically",
  force: "Squash and merge now, bypassing branch protection",
};

export type MergeChoices = {
  /** The status row's button, when one applies. */
  primary: MergeChoice | null;
  /** Every choice that applies, primary included, for the menus. */
  all: MergeChoice[];
  /** What a force merge would go around, for its confirmation. */
  bypasses: string[];
};

/** Merge-box states where GitHub is holding the merge back. */
const HELD_STATES = new Set(["BLOCKED", "BEHIND", "UNSTABLE"]);

/**
 * Which merge actions an open PR offers. Running checks alone do not hide a
 * plain merge: the host still enforces required checks, and waiting on a
 * slow optional one should not take the button away.
 */
export function mergeChoices(
  pr: Pick<
    PrDetails,
    | "state"
    | "isDraft"
    | "mergeable"
    | "mergeStateStatus"
    | "reviewDecision"
    | "autoMerge"
  >,
  checks: { failed: number; pending: number },
  caps: Pick<PrHostCapabilities, "autoMerge" | "forceMerge">,
): MergeChoices {
  const none: MergeChoices = { primary: null, all: [], bypasses: [] };
  if (pr.state !== "OPEN" || pr.isDraft || pr.mergeable === "CONFLICTING")
    return none;

  const held = HELD_STATES.has(pr.mergeStateStatus || "");
  const canMerge = checks.failed === 0 && pr.mergeStateStatus !== "BLOCKED";
  const waiting = held || checks.failed > 0 || checks.pending > 0;

  const bypasses: string[] = [];
  if (checks.failed)
    bypasses.push(
      `${checks.failed} failing check${checks.failed === 1 ? "" : "s"}`,
    );
  if (checks.pending)
    bypasses.push(
      `${checks.pending} running check${checks.pending === 1 ? "" : "s"}`,
    );
  if (pr.reviewDecision === "CHANGES_REQUESTED")
    bypasses.push("requested changes");
  else if (pr.reviewDecision === "REVIEW_REQUIRED")
    bypasses.push("a required review");
  if (pr.mergeStateStatus === "BEHIND")
    bypasses.push("the up-to-date branch rule");
  if (pr.mergeStateStatus === "BLOCKED" && !bypasses.length)
    bypasses.push("branch protection");

  const all: MergeChoice[] = [];
  if (canMerge) all.push("merge");
  if (caps.autoMerge !== false)
    if (pr.autoMerge) all.push("cancel-auto");
    else if (waiting) all.push("auto");
  if (caps.forceMerge !== false && waiting) all.push("force");

  const primary: MergeChoice | null = canMerge
    ? "merge"
    : all.includes("auto")
      ? "auto"
      : null;
  return { primary, all, bypasses };
}
