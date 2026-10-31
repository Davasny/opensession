/**
 * How a newly assigned Linear issue starts work.
 *
 * `ask` keeps the historical greeting and waits for a plan/implement reply.
 * `plan` starts the planning interview immediately. `implement` starts the
 * implementation turn immediately and is the only mode that moves the issue
 * without a person's reply, so it remains an explicit opt-in.
 */
import { configuredIntegration } from "../../server/config";

export type LinearStartMode = "ask" | "plan" | "implement";

const warned = new Set<string>();

function warnInvalid(source: string, value: string): void {
  const bounded = value.slice(0, 80);
  const warning = `${source}=${bounded}`;
  if (warned.has(warning)) return;
  if (warned.size < 32) warned.add(warning);
  console.warn(
    `[linear] Unknown start mode "${bounded}" from ${source}; using "ask"`,
  );
}

function parseMode(value: unknown, source: string): LinearStartMode | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") {
    warnInvalid(source, String(value));
    return "ask";
  }
  const normalized = value.trim().toLowerCase();
  if (!normalized) {
    warnInvalid(source, "(empty)");
    return "ask";
  }
  if (
    normalized === "ask" ||
    normalized === "plan" ||
    normalized === "implement"
  )
    return normalized;
  warnInvalid(source, normalized);
  return "ask";
}

/** Environment wins over config. Unknown values fail safe to `ask`. */
export function linearStartMode(): LinearStartMode {
  const envValue = process.env.LINEAR_START_MODE;
  if (envValue !== undefined && envValue.trim()) {
    const env = parseMode(envValue, "LINEAR_START_MODE");
    if (env) return env;
  }
  const integration = configuredIntegration("linear");
  const configured =
    "startMode" in integration
      ? parseMode(integration.startMode, "integrations.linear.startMode")
      : null;
  return configured ?? "ask";
}
