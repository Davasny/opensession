import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  clientDiagnosticsDir,
  handleClientDiagnosticsRoutes,
} from "./routes/client-diagnostics";

const scratch = mkdtempSync(join(tmpdir(), "client-diag-"));
const saved = process.env.OPENSESSION_STATE_DIR;
process.env.OPENSESSION_STATE_DIR = scratch;
afterAll(() => {
  if (saved === undefined) delete process.env.OPENSESSION_STATE_DIR;
  else process.env.OPENSESSION_STATE_DIR = saved;
  rmSync(scratch, { recursive: true, force: true });
});

function post(body: string, login?: string) {
  const req = new Request("http://example.test/api/client-diagnostics", {
    method: "POST",
    body,
  });
  return handleClientDiagnosticsRoutes({
    req,
    url: new URL(req.url),
    path: "/api/client-diagnostics",
    publicPrefix: "",
    ...(login ? { authUser: { login, name: login } } : {}),
  });
}

test("a signed-in app's crash report is kept as one file", async () => {
  const response = await post(
    JSON.stringify({ kind: "crash", build: "836", payload: { frames: [1] } }),
    "alice",
  );
  expect(response?.status).toBe(200);
  const files = readdirSync(clientDiagnosticsDir());
  expect(files).toHaveLength(1);
  expect(files[0]).toContain("-alice-crash-");
  const stored = JSON.parse(
    readFileSync(join(clientDiagnosticsDir(), files[0]!), "utf8"),
  );
  expect(stored).toMatchObject({ kind: "crash", build: "836", login: "alice" });
});

test("diagnostics need a signed-in user and a JSON object", async () => {
  expect((await post("{}"))?.status).toBe(401);
  expect((await post("[]", "alice"))?.status).toBe(400);
  expect((await post("nope", "alice"))?.status).toBe(400);
});
