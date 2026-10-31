/**
 * Open (or recover) the pull request for a Linear session's checkout.
 *
 * The agent owns the description of the code it wrote. This module owns the
 * mechanics a run must not forge: the repository credential, the actual head
 * branch, idempotent lookup, reviewer assignment, the session-attribution
 * footer, and the public-repository safety gate.
 *
 * It is intentionally separate from the session lifecycle. The session state
 * machine decides when implementation is complete; this module only turns that
 * decision into a PR.
 */

import { privateTerms } from "../../server/config";
import { githubServiceCredentialEnv } from "../../server/github-app";
import { homeDir } from "../../server/paths";
import {
  composePrBody,
  findPrivateTerm,
  prAttributionFooter,
  spliceAgentPrBody,
} from "../../server/pr-body";
import { treatRepoAsPublic } from "../../server/repo-visibility";
import { sessionLink } from "../../server/run-instructions";
import {
  repoForPathOrNull,
  worktreeHeadBranchAsync,
} from "../../server/worktree";
import type { Participant } from "./session";

export interface PrCreateResult {
  url: string | null;
  /** Short, safe explanation when no URL was produced: fixed messages only.
   *  gh's raw output stays in the server log, never in a Linear timeline. */
  reason?: string;
  /** True only when this call created the PR. A reused or recovered PR is
   *  false, so the caller knows it may need its description refreshed. */
  created?: boolean;
}

export interface CreateLinearPrOptions {
  /** Reviewer-facing Markdown the agent wrote after the PR-body sentinel. */
  agentBody?: string;
  /** Unified session id (`linear-…`) for the attribution footer. */
  sessionId?: string;
  /** The Linear requester named in the footer. */
  author?: string | null;
  /** Visibility already resolved by a caller; omitted = resolve here. */
  publicRepo?: boolean;
}

/** Classify gh's failure text into a short explanation safe to show. */
function describeGhFailure(stderr: string): string {
  const text = stderr.toLowerCase();
  if (text.includes("already exists"))
    return "a pull request already exists for this branch";
  if (
    /not logged in|authentication|bad credentials|gh_token|http 401/.test(text)
  )
    return "GitHub authentication failed";
  if (/no commits between|no commits/.test(text))
    return "the branch has no commits to open a pull request from";
  if (
    /not been pushed|no upstream|does not have any commits|publish/.test(text)
  )
    return "the branch has not been pushed";
  return "gh pr create failed";
}

/**
 * Open (or recover) the pull request for this session's checkout.
 *
 * Idempotent by construction: an open PR for the worktree's actual head branch
 * is returned as-is, and a create that exits non-zero is checked against
 * GitHub before being reported as a failure (gh creates the PR first and can
 * fail afterwards on a reviewer request). A reviewer request failure is
 * logged but never hides an already-created PR.
 */
export async function createPrWithAttribution(
  worktreeDir: string,
  issueIdentifier: string,
  issueUrl: string,
  issueTitle: string,
  participants: Participant[],
  reviewer?: string | null,
  options: CreateLinearPrOptions = {},
): Promise<PrCreateResult> {
  const repo = repoForPathOrNull(worktreeDir);
  if (!repo?.ghRepo || repo.host === "codestorage") {
    console.error(
      "[linear] Cannot create PR: worktree has no registered GitHub repository",
    );
    return {
      url: null,
      reason: "this workspace has no registered GitHub repository",
    };
  }

  // The agent can switch branches inside its worktree, and gh targets HEAD:
  // look up the branch that actually exists, not the session's original claim.
  const branch = await worktreeHeadBranchAsync(worktreeDir);
  if (!branch) {
    console.error("[linear] Cannot create PR: checkout is not on a branch");
    return { url: null, reason: "the checkout is not on a branch" };
  }

  const publicRepo = options.publicRepo ?? (await treatRepoAsPublic(repo));

  const footer = options.sessionId
    ? prAttributionFooter({
        sessionUrl: sessionLink(options.sessionId),
        author: options.author,
      })
    : undefined;

  const title = `${issueIdentifier}: ${issueTitle}`;
  const body = composePrBody({
    agentBody: options.agentBody,
    ticket: {
      identifier: issueIdentifier,
      title: issueTitle,
      // A Linear issue URL names the private workspace. Public repositories
      // only ever get the identifier, title, and attribution footer.
      url: publicRepo ? undefined : issueUrl,
    },
    participants: publicRepo ? [] : participants.map((p) => p.name),
    testPlan: ["Verify implementation meets acceptance criteria"],
    footer,
  });

  if (publicRepo) {
    const hit = findPrivateTerm(`${title}\n${body}`, privateTerms());
    if (hit) {
      // Fail closed: the body never leaves the machine with a configured
      // private term in it. The caller reports a fixed reason to Linear.
      console.error(
        `[linear] Refusing to publish PR for ${repo.ghRepo}: body contains private term "${hit}"`,
      );
      return {
        url: null,
        reason:
          "the pull request title or description contains private organization information",
      };
    }
  }

  try {
    const credentialEnv = await githubServiceCredentialEnv(repo.ghRepo);
    if (!credentialEnv.GH_TOKEN) {
      console.error(
        `[linear] Cannot create PR: GitHub App credential unavailable for ${repo.ghRepo}`,
      );
      return {
        url: null,
        reason: `GitHub credentials are unavailable for ${repo.ghRepo}`,
      };
    }

    const runGh = async (args: string[]) => {
      const proc = Bun.spawn(args, {
        cwd: worktreeDir,
        stdout: "pipe",
        stderr: "pipe",
        env: {
          ...process.env,
          ...credentialEnv,
          // Never let an interactive prompt wedge an unattended turn.
          GH_PROMPT_DISABLED: "1",
          PATH: `${homeDir()}/.cargo/bin:${homeDir()}/.bun/bin:${homeDir()}/.local/bin:${homeDir()}/bin:${homeDir()}/.npm-global/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin`,
          HOME: homeDir(),
        },
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout, stderr, exitCode };
    };

    const findOpenPr = async (): Promise<string | null> => {
      const result = await runGh([
        "gh",
        "pr",
        "list",
        "--repo",
        repo.ghRepo,
        "--head",
        branch,
        "--state",
        "open",
        "--json",
        "url",
        "--limit",
        "1",
      ]);
      if (result.exitCode !== 0) return null;
      try {
        const rows = JSON.parse(result.stdout);
        if (Array.isArray(rows) && typeof rows[0]?.url === "string")
          return rows[0].url;
      } catch {}
      return null;
    };

    const existing = await findOpenPr();
    if (existing) {
      console.log(`[linear] Reusing existing PR for ${branch}: ${existing}`);
      return { url: existing, created: false };
    }

    const created = await runGh([
      "gh",
      "pr",
      "create",
      "--repo",
      repo.ghRepo,
      "--head",
      branch,
      "--title",
      title,
      "--body",
      body,
    ]);
    if (created.exitCode !== 0) {
      // gh may have opened the PR and then failed on a later step (reviewer
      // request, network). Ask GitHub before reporting a failure.
      const recovered = await findOpenPr();
      if (recovered) {
        console.log(
          `[linear] Recovered PR after gh failure for ${branch}: ${recovered}`,
        );
        return { url: recovered, created: false };
      }
      console.error(`[linear] Failed to create PR: ${created.stderr}`);
      return { url: null, reason: describeGhFailure(created.stderr) };
    }

    const urlMatch = created.stdout.match(/https:\/\/github\.com\/[^\s]+/);
    const url = urlMatch ? urlMatch[0] : created.stdout.trim();
    if (!url) {
      console.error("[linear] gh pr create returned no pull request URL");
      return {
        url: null,
        reason: "gh did not return a pull request URL",
      };
    }

    if (reviewer) {
      // Requesting a reviewer is secondary: a rejected login or a transient
      // GitHub error must not turn a created PR into a reported failure.
      const added = await runGh([
        "gh",
        "pr",
        "edit",
        url,
        "--add-reviewer",
        reviewer,
      ]);
      if (added.exitCode !== 0) {
        console.warn(
          `[linear] Created ${url} but could not request reviewer ${reviewer}: ${added.stderr.trim().slice(0, 200)}`,
        );
      }
    }

    return { url, created: true };
  } catch (e) {
    console.error(`[linear] Error creating PR: ${e}`);
    return { url: null, reason: "the pull request command failed" };
  }
}

/**
 * Keep the PR description current when a later implementation turn adds work.
 *
 * Only the managed section is replaced. A body without the markers is left
 * alone, so a human-edited description or a PR created before this contract is
 * never overwritten.
 */
export async function updatePrDescriptionFromAgent(input: {
  worktreeDir: string;
  prUrl: string;
  agentBody: string;
}): Promise<{ updated: boolean; reason?: string }> {
  const agentBody = input.agentBody.trim();
  if (!agentBody) return { updated: false };

  const repo = repoForPathOrNull(input.worktreeDir);
  if (!repo?.ghRepo || repo.host === "codestorage")
    return {
      updated: false,
      reason: "this workspace has no registered GitHub repository",
    };
  const branch = await worktreeHeadBranchAsync(input.worktreeDir);
  if (!branch)
    return { updated: false, reason: "the checkout is not on a branch" };

  let spliced = false;
  const { updatePrBody } = await import("../../server/pr-info");
  const result = await updatePrBody(
    branch,
    (body) => {
      const next = spliceAgentPrBody(body, agentBody);
      spliced = next !== body;
      return next;
    },
    repo.ghRepo,
  );
  if ("error" in result) {
    console.warn(
      `[linear] Could not update PR ${input.prUrl} description: ${result.error}`,
    );
    return {
      updated: false,
      reason: "the pull request description could not be updated",
    };
  }
  if (result.url !== input.prUrl) {
    console.warn(
      `[linear] Refusing to update PR ${result.url} for session PR ${input.prUrl}`,
    );
    return {
      updated: false,
      reason: "the branch has a different pull request",
    };
  }
  if (!spliced)
    return {
      updated: false,
      reason: "the pull request has no managed description section",
    };
  return { updated: true };
}
