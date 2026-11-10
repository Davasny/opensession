import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { stateDir } from "../../server/paths";
import { defaultRepo } from "../../server/config";
import type { Automation } from "../../server/automations";
import { linearSessionFileKey } from "./session-store";

/** General tasks get durable scratch, not the default repository. Repository
 * modes use the same checkout helpers as the automation runner. */
export async function createLinearTaskWorkspace(
  sessionId: string,
  config: Automation,
): Promise<{
  worktreeDir: string;
  repoId: string;
  ownsWorktree: boolean;
  branch: string;
}> {
  if (config.mode === "scratch") {
    const key = linearSessionFileKey(sessionId);
    const worktreeDir = join(stateDir("linear-workspaces"), key);
    await mkdir(worktreeDir, { recursive: true, mode: 0o700 });
    return { worktreeDir, repoId: "", ownsWorktree: false, branch: "" };
  }
  const { ensureAskCheckout } = await import("../../server/worktree");
  const repoId = config.repo || defaultRepo().id;
  return {
    worktreeDir: await ensureAskCheckout(repoId),
    repoId,
    ownsWorktree: false,
    branch: "",
  };
}
