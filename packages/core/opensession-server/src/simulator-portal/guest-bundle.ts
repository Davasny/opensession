import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { buildSimulatorViewerFromSource } from "./assets";

/**
 * Build the simulator Portal as a self-contained payload for a macOS Sandbox:
 * `main.js` (the viewer process, bundled with its dependencies) and an
 * `assets/` directory of the built browser viewer. The guest has Bun but no
 * Open Session checkout, so the host builds this once and uploads it
 * (server/sandbox-simulator-portal.ts). Run as its own process so bundling
 * never happens on the gateway thread:
 *
 *   bun src/simulator-portal/guest-bundle.ts <outDir>
 */
export async function writeSimulatorGuestBundle(outDir: string): Promise<void> {
  await rm(outDir, { recursive: true, force: true });
  await mkdir(join(outDir, "assets"), { recursive: true });
  const bundle = await Bun.build({
    entrypoints: [join(import.meta.dir, "main.ts")],
    target: "bun",
    minify: true,
  });
  if (!bundle.success)
    throw new Error(`Simulator guest bundle failed: ${bundle.logs.join("\n")}`);
  const [entry] = bundle.outputs;
  if (!entry || bundle.outputs.length !== 1)
    throw new Error("Simulator guest bundle produced more than one file");
  await Bun.write(join(outDir, "main.js"), entry);
  for (const [served, blob] of await buildSimulatorViewerFromSource()) {
    if (served === "/") continue;
    const name = served.slice(1);
    if (!name || name.includes("/"))
      throw new Error(`unexpected simulator viewer asset path ${served}`);
    await Bun.write(join(outDir, "assets", name), blob);
  }
}

if (import.meta.main) {
  const outDir = process.argv[2];
  if (!outDir) {
    console.error("usage: guest-bundle.ts <outDir>");
    process.exit(2);
  }
  await writeSimulatorGuestBundle(outDir);
}
