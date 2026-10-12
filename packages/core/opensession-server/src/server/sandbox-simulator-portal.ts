import { createHash } from "node:crypto";
import { mkdtemp, readdir, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, posix, resolve } from "node:path";
import type { z } from "zod";
import { isCompiledBinary } from "../runner-host/exe";
import { SIMULATOR_VIEWER_ASSETS_ENV } from "../simulator-portal/assets";
import {
  darwinIosToolsCheckScript,
  darwinIosToolsInstallScript,
  darwinIosToolsPaths,
  remoteGuestOsForProvider,
  remoteLayoutForProvider,
  shellQuoteWord,
} from "./sandbox/adapters/bootstrap";
import type { Sandbox } from "./sandbox/provider";
import { sandboxSessionScratchDir } from "./session-scratch";
import {
  simulatorPortalName,
  type simulatorPortalInput,
} from "./simulator-portal-command";

/**
 * Simulator Portals inside a macOS Sandbox (tart, use.computer). The guest has
 * Xcode and Bun but no Open Session checkout, so the host bundles the viewer
 * process and its browser assets once (simulator-portal/guest-bundle.ts, in a
 * child process so nothing is bundled on the gateway thread), uploads them to
 * the session's guest scratch keyed by content hash, and starts them as an
 * ordinary Sandbox Portal. Its relay carries the viewer like any other app.
 */

type GuestBundle = { hash: string; files: { path: string; data: Buffer }[] };

let guestBundle: Promise<GuestBundle> | null = null;

async function buildGuestBundle(): Promise<GuestBundle> {
  if (isCompiledBinary())
    throw new Error(
      "Simulator Portals in a Sandbox need a source installation of Open Session.",
    );
  const outDir = await mkdtemp(join(tmpdir(), "opensession-simulator-guest-"));
  const child = Bun.spawn(
    [
      process.execPath,
      resolve(import.meta.dir, "../simulator-portal/guest-bundle.ts"),
      outDir,
    ],
    { stdout: "pipe", stderr: "pipe" },
  );
  const [stderr, code] = await Promise.all([
    new Response(child.stderr).text(),
    child.exited,
  ]);
  if (code !== 0)
    throw new Error(
      `Could not bundle the simulator viewer: ${stderr.slice(-1_000)}`,
    );
  const paths = [
    "main.js",
    ...(await readdir(join(outDir, "assets"))).map((name) => `assets/${name}`),
  ].sort();
  const files = await Promise.all(
    paths.map(async (path) => ({
      path,
      data: await readFile(join(outDir, path)),
    })),
  );
  const hash = createHash("sha256");
  for (const file of files)
    hash.update(file.path).update("\0").update(file.data);
  return { hash: hash.digest("hex").slice(0, 16), files };
}

function simulatorGuestBundle(): Promise<GuestBundle> {
  guestBundle ??= buildGuestBundle().catch((error) => {
    guestBundle = null;
    throw error;
  });
  return guestBundle;
}

/** Below the guest's ARG_MAX once wrapped in a shell command. */
const UPLOAD_CHUNK_CHARS = 150_000;

async function run(sandbox: Sandbox, script: string, what: string) {
  const result = await sandbox.exec(["bash", "-c", script], {
    timeoutMs: 60_000,
  });
  if (result.exitCode !== 0)
    throw new Error(
      `${what} failed: ${(result.stderr || result.stdout).trim().slice(0, 300)}`,
    );
  return result;
}

/** Upload the bundle unless this content is already in the guest. Returns its
 *  directory there. */
async function uploadGuestBundle(
  sandbox: Sandbox,
  sessionId: string,
  bundle: GuestBundle,
): Promise<string> {
  const dir = posix.join(
    sandboxSessionScratchDir(sessionId, sandbox.provider),
    "simulator-viewer",
    bundle.hash,
  );
  const ready = await sandbox.exec([
    "test",
    "-f",
    posix.join(dir, ".complete"),
  ]);
  if (ready.exitCode === 0) return dir;
  for (const file of bundle.files) {
    const target = posix.join(dir, file.path);
    const staged = `${target}.b64`;
    const encoded = file.data.toString("base64");
    await run(
      sandbox,
      `mkdir -p ${shellQuoteWord(posix.dirname(target))} && : > ${shellQuoteWord(staged)}`,
      "Preparing the simulator viewer upload",
    );
    for (let at = 0; at < encoded.length; at += UPLOAD_CHUNK_CHARS)
      await run(
        sandbox,
        `printf %s ${shellQuoteWord(encoded.slice(at, at + UPLOAD_CHUNK_CHARS))} >> ${shellQuoteWord(staged)}`,
        "Uploading the simulator viewer",
      );
    const expected = createHash("sha256").update(file.data).digest("hex");
    await run(
      sandbox,
      `base64 -d < ${shellQuoteWord(staged)} > ${shellQuoteWord(target)} && rm -f ${shellQuoteWord(staged)} && [ "$(shasum -a 256 ${shellQuoteWord(target)} | cut -d ' ' -f 1)" = ${expected} ]`,
      `Verifying ${file.path} in the Sandbox`,
    );
  }
  await run(
    sandbox,
    `touch ${shellQuoteWord(posix.join(dir, ".complete"))}`,
    "Finishing the simulator viewer upload",
  );
  return dir;
}

/** A workspace-relative path that cannot leave the workspace. The viewer
 *  checks the resolved bundle again inside the guest. */
export function sandboxSimulatorAppPath(appPath: string): string {
  const normalized = posix.normalize(appPath);
  if (
    posix.isAbsolute(appPath) ||
    appPath.includes("\0") ||
    normalized === ".." ||
    normalized.startsWith("../") ||
    !normalized.endsWith(".app")
  )
    throw new Error(
      "appPath must be a simulator .app inside this session's workspace, relative to it.",
    );
  return normalized;
}

export function sandboxSupportsSimulatorPortal(sandbox: Sandbox): boolean {
  return remoteGuestOsForProvider(sandbox.provider) === "darwin";
}

/** idb, idb_companion and xcodegen in the guest. Sandboxes prepared before
 *  they joined macOS guest preparation, or whose background install has not
 *  finished, get the install started and a clear answer instead of a viewer
 *  that fails to boot. */
async function ensureGuestIosTools(sandbox: Sandbox): Promise<void> {
  const guest = remoteLayoutForProvider(sandbox.provider);
  const check = await sandbox.exec([
    "bash",
    "-c",
    darwinIosToolsCheckScript(guest),
  ]);
  if (check.exitCode === 0) return;
  const { log, lock } = darwinIosToolsPaths(guest);
  const running = (await sandbox.exec(["test", "-d", lock])).exitCode === 0;
  if (!running)
    await sandbox.exec(["bash", "-c", darwinIosToolsInstallScript(guest)], {
      background: true,
      timeoutMs: 15_000,
    });
  throw new Error(
    `idb, idb_companion and xcodegen are ${running ? "still installing" : "now installing"} in this Sandbox, which takes a few minutes. Its log is ${log}. Call start_simulator_portal again once it ends with "iOS simulator tools ready".`,
  );
}

/** The Portal start for a simulator viewer inside a macOS Sandbox. */
export async function sandboxSimulatorPortalCommand(
  input: z.infer<z.ZodObject<typeof simulatorPortalInput>> & {
    sessionId: string;
    sandbox: Sandbox;
  },
) {
  if (!sandboxSupportsSimulatorPortal(input.sandbox))
    throw new Error(
      "Simulator Portals need a macOS Sandbox (Mac VM or use.computer).",
    );
  const app = sandboxSimulatorAppPath(input.appPath);
  await ensureGuestIosTools(input.sandbox);
  const dir = await uploadGuestBundle(
    input.sandbox,
    input.sessionId,
    await simulatorGuestBundle(),
  );
  const guest = remoteLayoutForProvider(input.sandbox.provider);
  const args = [
    "env",
    `${SIMULATOR_VIEWER_ASSETS_ENV}=${posix.join(dir, "assets")}`,
    guest.bun,
    posix.join(dir, "main.js"),
    "--session",
    input.sessionId,
    "--workspace",
    input.sandbox.cwd,
    "--app",
    app,
  ];
  if (input.deviceType) args.push("--device-type", input.deviceType);
  if (input.runtime) args.push("--runtime", input.runtime);
  return {
    name: simulatorPortalName(input.sessionId),
    command: args.map(shellQuoteWord).join(" "),
    description: "Interactive iOS simulator powered by idb",
    defaultPath: "/",
    readyTimeoutMs: 90_000,
    shutdownGraceMs: 30_000,
  };
}
