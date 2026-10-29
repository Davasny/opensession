/**
 * Paths and durable terminal state for the Linear agent session store.
 *
 * Kept in a leaf module (no catalog, runner or gateway imports) so the session
 * loop and the gateway's engine-id sync use exactly one naming rule. The store
 * directory is resolved per call so a test or dev instance that repoints HOME /
 * OPENSESSION_STATE_DIR sees its own store.
 */
import { rm } from "node:fs/promises";
import { agentSessionSourceDirectory } from "../../server/agent-session-source";
import { writeJsonAtomicAsync } from "../../server/shared/atomic-write";

/**
 * Prefix for a session file keyed by its Linear agent-session id. The `~` can
 * never appear in a generated branch, so a current file can never collide with
 * a legacy `<branch>.json` file.
 */
const AGENT_SESSION_KEY_PREFIX = "agent~";

/** Terminal markers live in a subdirectory, so the Linear source scanner
 *  (which reads files directly in the store directory) never mistakes one for
 *  a session. */
const TERMINAL_DIR = ".ended";
const STOPPED_DIR = ".stopped";

export function linearSessionDirectory(): string {
  return agentSessionSourceDirectory("linear");
}

/**
 * The store file key for a Linear agent session: its Linear agent-session id,
 * not the branch. A branch is derived from the issue title and identifier, so
 * ending a session and assigning the same issue again reuses the branch; the
 * agent-session id is the only durable identity that tells the two apart.
 */
export function linearSessionFileKey(linearSessionId: string): string {
  const id = linearSessionId.trim();
  const encoded = encodeURIComponent(id);
  if (!id || encoded.length > 180 || /[/\\]/.test(encoded)) {
    throw new Error(
      `Invalid Linear agent session id for a session file: ${JSON.stringify(linearSessionId)}`,
    );
  }
  return `${AGENT_SESSION_KEY_PREFIX}${encoded}`;
}

/** The unified session id a store file key projects to. */
export function linearUnifiedSessionId(fileKey: string): string {
  return `linear-${fileKey}`;
}

/** Whether a store key is a current agent-session-id key (not a legacy branch
 *  key). */
export function isAgentSessionFileKey(sessionKey: string): boolean {
  return sessionKey.startsWith(AGENT_SESSION_KEY_PREFIX);
}

/** The agent-session id a current file key encodes, if any. Legacy branch
 *  keys return undefined. */
export function linearSessionIdFromFileKey(
  sessionKey: string,
): string | undefined {
  if (!isAgentSessionFileKey(sessionKey)) return undefined;
  try {
    return decodeURIComponent(
      sessionKey.slice(AGENT_SESSION_KEY_PREFIX.length),
    );
  } catch {
    return undefined;
  }
}

/** One session file path, derived from a vetted key. Null refuses a key that
 *  could escape the store directory. */
export function linearSessionFilePath(sessionKey: string): string | null {
  if (
    !sessionKey ||
    sessionKey === "." ||
    sessionKey === ".." ||
    sessionKey.includes("/") ||
    sessionKey.includes("\\")
  )
    return null;
  return `${linearSessionDirectory()}/${sessionKey}.json`;
}

function terminalPath(linearSessionId: string): string | null {
  let key: string;
  try {
    key = linearSessionFileKey(linearSessionId);
  } catch {
    return null;
  }
  return `${linearSessionDirectory()}/${TERMINAL_DIR}/${key}`;
}

/** Record that this agent session ended. Written before its store file and
 *  worktree are removed, so a replay after a restart cannot resurrect it. */
export async function markLinearSessionTerminal(
  linearSessionId: string,
  endedAt = new Date().toISOString(),
): Promise<void> {
  const path = terminalPath(linearSessionId);
  if (!path)
    throw new Error(
      `Cannot record terminal state for invalid Linear session id ${JSON.stringify(linearSessionId)}`,
    );
  await writeJsonAtomicAsync(path, { linearSessionId, endedAt });
}

/** Async terminal check for request/recovery paths. */
export async function isLinearSessionTerminal(
  linearSessionId: string,
): Promise<boolean> {
  const path = terminalPath(linearSessionId);
  return !!path && (await Bun.file(path).exists());
}

function stoppedPath(linearSessionId: string): string | null {
  let key: string;
  try {
    key = linearSessionFileKey(linearSessionId);
  } catch {
    return null;
  }
  return `${linearSessionDirectory()}/${STOPPED_DIR}/${key}`;
}

/** A stop that arrived before the assignment claimed its one turn. This is
 *  durable even when no session file exists yet (stop during initial API work). */
export async function markLinearAssignmentStopped(
  linearSessionId: string,
  stoppedAt = new Date().toISOString(),
): Promise<void> {
  const path = stoppedPath(linearSessionId);
  if (!path)
    throw new Error(
      `Cannot record assignment stop for invalid Linear session id ${JSON.stringify(linearSessionId)}`,
    );
  await writeJsonAtomicAsync(path, { linearSessionId, stoppedAt });
}

export async function isLinearAssignmentStopped(
  linearSessionId: string,
): Promise<boolean> {
  const path = stoppedPath(linearSessionId);
  return !!path && (await Bun.file(path).exists());
}

/** An explicit human prompt clears the stop and may continue the session. */
export async function clearLinearAssignmentStopped(
  linearSessionId: string,
): Promise<void> {
  const path = stoppedPath(linearSessionId);
  if (path) await rm(path, { force: true });
}

// One write chain per file, shared by the Linear loop and the gateway's
// engine-id sync. A save queued behind an end's delete (or a sync behind a
// save) therefore lands in call order instead of racing the same file.
const fileWrites = new Map<string, Promise<void>>();

export function withSessionStoreWrite<T>(
  path: string,
  fn: () => Promise<T>,
): Promise<T> {
  const previous = fileWrites.get(path) ?? Promise.resolve();
  const next = previous.catch(() => {}).then(fn);
  const queued = next.then(
    () => {},
    () => {},
  );
  fileWrites.set(path, queued);
  return next.finally(() => {
    if (fileWrites.get(path) === queued) fileWrites.delete(path);
  });
}
