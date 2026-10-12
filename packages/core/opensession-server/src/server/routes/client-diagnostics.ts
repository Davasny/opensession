/**
 * Crash and hang reports from the native app.
 *
 * The iOS and macOS app subscribe to MetricKit, which hands the app its own
 * crash, hang and CPU-exception diagnostics on the next launch. Those arrive
 * here and are kept as one JSON file per report under the state directory, so
 * an operator (or an agent on this host) can read why a build crashed without
 * App Store Connect access. Reports carry stack frames and device metadata,
 * never transcript content.
 */
import { mkdir, readdir, rm, writeFile } from "fs/promises";
import { stateDir } from "../paths";
import type { RouteContext } from "./context";

/** One MetricKit payload is a few KB to a few hundred KB of frames. */
export const MAX_CLIENT_DIAGNOSTIC_BYTES = 2 * 1024 * 1024;
/** Oldest reports are pruned past this many files. */
const KEEP_REPORTS = 500;

export const clientDiagnosticsDir = () => stateDir("client-diagnostics");

function safePart(value: unknown, fallback: string): string {
  const text = typeof value === "string" ? value : "";
  const cleaned = text.replace(/[^A-Za-z0-9._-]/g, "").slice(0, 40);
  return cleaned || fallback;
}

export async function recordClientDiagnostic(
  login: string,
  body: Record<string, unknown>,
  now = new Date(),
): Promise<string> {
  const dir = clientDiagnosticsDir();
  await mkdir(dir, { recursive: true });
  const kind = safePart(body.kind, "diagnostic");
  const name = `${now.toISOString().replace(/[:.]/g, "-")}-${safePart(login, "user")}-${kind}-${crypto.randomUUID().slice(0, 8)}.json`;
  await writeFile(
    `${dir}/${name}`,
    JSON.stringify({ ...body, login, receivedAt: now.toISOString() }, null, 2),
    { flag: "wx" },
  );
  const files = (await readdir(dir)).filter((f) => f.endsWith(".json")).sort();
  for (const old of files.slice(0, Math.max(0, files.length - KEEP_REPORTS)))
    await rm(`${dir}/${old}`, { force: true });
  return name;
}

export async function handleClientDiagnosticsRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  if (ctx.path !== "/api/client-diagnostics" || ctx.req.method !== "POST")
    return undefined;
  const login = ctx.authUser?.login;
  if (!login)
    return Response.json(
      { error: "Sign in to send diagnostics." },
      { status: 401 },
    );
  const length = Number(ctx.req.headers.get("content-length") || 0);
  if (length > MAX_CLIENT_DIAGNOSTIC_BYTES)
    return Response.json({ error: "Diagnostic too large." }, { status: 413 });
  const raw = await ctx.req.text().catch(() => "");
  if (raw.length > MAX_CLIENT_DIAGNOSTIC_BYTES)
    return Response.json({ error: "Diagnostic too large." }, { status: 413 });
  let body: unknown;
  try {
    body = JSON.parse(raw);
  } catch {
    body = null;
  }
  if (!body || typeof body !== "object" || Array.isArray(body))
    return Response.json({ error: "Expected a JSON object." }, { status: 400 });
  const file = await recordClientDiagnostic(
    login,
    body as Record<string, unknown>,
  );
  console.log(`[client-diagnostics] stored ${file}`);
  return Response.json({ ok: true });
}
