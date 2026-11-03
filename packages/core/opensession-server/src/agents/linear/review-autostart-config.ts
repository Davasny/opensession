/**
 * Config for the GitHub review -> Linear fix-turn autostart.
 *
 * Off by default. A person opts in with `integrations.linear.reviewAutostart`
 * or `LINEAR_REVIEW_AUTOSTART`. Unknown values fail safe to off, matching the
 * assignment start-mode parser.
 */
import { configuredIntegration } from "../../server/config";
import type { ReviewTrustMode } from "./review-autostart-gates";

export interface LinearReviewAutostartConfig {
  enabled: boolean;
  /** Automatic fix rounds allowed per Linear session. */
  rounds: number;
  reviewers: ReviewTrustMode;
}

const DEFAULT_ROUNDS = 4;
const MAX_ROUNDS = 10;
const warned = new Set<string>();

function warnInvalid(source: string, value: string): void {
  const bounded = value.slice(0, 80);
  const warning = `${source}=${bounded}`;
  if (warned.has(warning)) return;
  if (warned.size < 32) warned.add(warning);
  console.warn(
    `[linear] Unknown review autostart value "${bounded}" from ${source}`,
  );
}

function parseEnabled(value: unknown, source: string): boolean | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value !== "string") {
    warnInvalid(source, String(value));
    return false;
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) return null;
  if (
    normalized === "off" ||
    normalized === "0" ||
    normalized === "false" ||
    normalized === "disabled"
  )
    return false;
  if (
    normalized === "changes-requested" ||
    normalized === "1" ||
    normalized === "true" ||
    normalized === "on"
  )
    return true;
  warnInvalid(source, normalized);
  return false;
}

function parseRounds(value: unknown, source: string): number | null {
  if (value === undefined || value === null || value === "") return null;
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? Number(value.trim())
        : NaN;
  if (!Number.isFinite(parsed) || parsed < 1) {
    warnInvalid(source, String(value));
    return null;
  }
  return Math.min(MAX_ROUNDS, Math.floor(parsed));
}

function parseReviewers(
  value: unknown,
  source: string,
): ReviewTrustMode | null {
  if (value === undefined || value === null || value === "") return null;
  if (typeof value !== "string") {
    warnInvalid(source, String(value));
    return "trusted";
  }
  const normalized = value.trim().toLowerCase();
  if (normalized === "trusted") return "trusted";
  if (normalized === "any-write" || normalized === "any") return "any-write";
  warnInvalid(source, normalized);
  return "trusted";
}

function sourceValue(
  envName: string,
  configValue: unknown,
  configKey: string,
): { value: unknown; source: string } {
  const env = process.env[envName];
  if (env !== undefined && env.trim()) return { value: env, source: envName };
  return { value: configValue, source: `integrations.linear.${configKey}` };
}

export function linearReviewAutostartConfig(): LinearReviewAutostartConfig {
  const integration = configuredIntegration("linear");

  const enabledInput = sourceValue(
    "LINEAR_REVIEW_AUTOSTART",
    integration.reviewAutostart,
    "reviewAutostart",
  );
  const enabled =
    parseEnabled(enabledInput.value, enabledInput.source) ?? false;

  const roundsInput = sourceValue(
    "LINEAR_REVIEW_AUTOSTART_ROUNDS",
    integration.reviewAutostartRounds,
    "reviewAutostartRounds",
  );
  const rounds =
    parseRounds(roundsInput.value, roundsInput.source) ?? DEFAULT_ROUNDS;

  const reviewersInput = sourceValue(
    "LINEAR_REVIEW_AUTOSTART_REVIEWERS",
    integration.reviewAutostartReviewers,
    "reviewAutostartReviewers",
  );
  const reviewers =
    parseReviewers(reviewersInput.value, reviewersInput.source) ?? "trusted";

  return { enabled, rounds, reviewers };
}

export function linearReviewAutostartEnabled(): boolean {
  return linearReviewAutostartConfig().enabled;
}
