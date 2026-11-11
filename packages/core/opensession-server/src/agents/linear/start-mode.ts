/**
 * How a newly assigned Linear issue starts work, configured per app.
 *
 * `ask` keeps the historical greeting and waits for a plan/implement reply.
 * `plan` starts the planning interview immediately. `implement` starts the
 * implementation turn immediately and is the only mode that moves the issue
 * without a person's reply, so it remains an explicit opt-in.
 *
 * The setting lives on the app: `integrations.linear.startMode` for the primary
 * app and `integrations.linear.apps[].startMode` for every additional app.
 * Operators edit it in each app's agent settings.
 */
import { linearAppById } from "../../server/linear-app-registry";

export type LinearStartMode = "ask" | "plan" | "implement";

/** The app's configured mode. Unset falls back to `ask`; the app registry
 *  already filters out values it cannot parse. */
export function linearAppStartMode(appId: string): LinearStartMode {
  return linearAppById(appId)?.startMode ?? "ask";
}

/**
 * The mode a new assignment uses. General and read-only agents always start
 * the assigned task, because the planning and implementation flow only applies
 * to coding agents; coding agents use their own configured mode.
 */
export function linearStartModeFor(
  appId: string,
  taskMode: string | undefined,
): LinearStartMode {
  if (taskMode && taskMode !== "code") return "implement";
  return linearAppStartMode(appId);
}
