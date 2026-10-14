/**
 * A session's builds and rollouts (session-builds.ts), for the card in the
 * session. Live changes arrive as `session_builds` frames.
 *
 *   GET /api/builds?sessionId=   -> { builds }
 */
import type { RouteContext } from "./context";
import { listSessionBuilds } from "../session-builds";

export async function handleBuildRoutes(
  ctx: RouteContext,
): Promise<Response | undefined> {
  if (ctx.path !== "/api/builds" || ctx.req.method !== "GET") return undefined;
  const sessionId = ctx.url.searchParams.get("sessionId") || "";
  return Response.json(
    { builds: sessionId ? await listSessionBuilds(sessionId) : [] },
    { headers: { "Cache-Control": "no-store" } },
  );
}
