import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createMcpRuntime, type McpRuntime } from "./mcp-runtime";
import {
  parseOomKills,
  readSandboxPortalLog,
  sandboxPortProbeArgv,
  sandboxPortProbeState,
} from "./portal-supervisor";
import {
  createPortalsMcpServer,
  describeOomKills,
  formatPortalLog,
} from "./portals-mcp";
import type { Sandbox } from "./sandbox/provider";

const KERNEL_LOG = [
  "[  459.429841] oom-kill:constraint=CONSTRAINT_NONE,nodemask=(null),global_oom,task=next-server (v1),pid=29315,uid=1000",
  "[  459.429897] Out of memory: Killed process 29315 (next-server (v1) total-vm:31836220kB, anon-rss:5810076kB, file-rss:3200kB, shmem-rss:0kB, UID:1000 pgtables:48608kB oom_score_adj:0",
].join("\n");

const dirs: string[] = [];
const runtimes: McpRuntime[] = [];

afterEach(async () => {
  for (const runtime of runtimes.splice(0)) await runtime.close();
  for (const dir of dirs.splice(0))
    await rm(dir, { recursive: true, force: true });
});

/** Runs Sandbox commands on the host, with the guest scratch root and the
 *  kernel log redirected into a temporary directory. */
async function fakeSandbox(
  log: string | null,
  kernel = KERNEL_LOG,
): Promise<{ sandbox: Sandbox; commands: string[] }> {
  const dir = await mkdtemp(join(tmpdir(), "portal-log-"));
  dirs.push(dir);
  const guestRoot = "/home/ubuntu/.opensession/session-scratch";
  const hostRoot = join(dir, "scratch");
  await mkdir(join(hostRoot, "session-a", "portals"), { recursive: true });
  if (log !== null)
    await writeFile(join(hostRoot, "session-a", "portals", "web.log"), log);
  await writeFile(join(dir, "kernel.txt"), kernel);
  const commands: string[] = [];
  const sandbox: Sandbox = {
    id: "sandbox-log-test",
    provider: "box",
    cwd: dir,
    async exec(command) {
      commands.push(command.join(" "));
      const translated = command.map((part) =>
        part
          .replaceAll(guestRoot, hostRoot)
          .replace(
            "{ sudo -n dmesg 2>/dev/null || dmesg 2>/dev/null; }",
            `cat ${join(dir, "kernel.txt")}`,
          ),
      );
      const proc = Bun.spawn(translated, {
        cwd: dir,
        stdout: "pipe",
        stderr: "pipe",
      });
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { exitCode, stdout, stderr };
    },
    async ports() {
      return {};
    },
    async status() {
      return "running";
    },
  };
  return { sandbox, commands };
}

describe("parseOomKills", () => {
  test("reads the killed process, including a name with parentheses", () => {
    expect(parseOomKills(KERNEL_LOG)).toEqual([
      { pid: 29315, process: "next-server (v1)", rssMb: 5674 },
    ]);
    // A memory cgroup kill reads the same after its prefix.
    expect(
      parseOomKills(
        "[ 662.2] Memory cgroup out of memory: Killed process 38348 (next-server (v1) total-vm:31966788kB, anon-rss:7207100kB, file-rss:0kB",
      ),
    ).toEqual([{ pid: 38348, process: "next-server (v1)", rssMb: 7038 }]);
  });

  test("an empty or unrelated kernel log has no kills", () => {
    expect(parseOomKills("")).toEqual([]);
    expect(parseOomKills("[ 1.0] usb 1-1: new device")).toEqual([]);
  });
});

describe("sandboxPortProbeState", () => {
  test("only an opened or refused connection is conclusive", () => {
    expect(sandboxPortProbeState({ exitCode: 0, stderr: "" })).toBe(
      "listening",
    );
    expect(sandboxPortProbeState({ exitCode: 1, stderr: "" })).toBe("closed");
    expect(
      sandboxPortProbeState({
        exitCode: 1,
        stderr:
          "bash: connect: Connection refused\nbash: line 1: /dev/tcp/127.0.0.1/4000: Connection refused",
      }),
    ).toBe("closed");
    expect(sandboxPortProbeState({ exitCode: 124, stderr: "" })).toBe(
      "unknown",
    );
    // perl's alarm on a macOS guest exits by SIGALRM.
    expect(sandboxPortProbeState({ exitCode: 142, stderr: "" })).toBe(
      "unknown",
    );
    expect(
      sandboxPortProbeState({
        exitCode: 1,
        stderr: "box API POST /sandboxes/bx_1/commands timed out after 32s",
      }),
    ).toBe("unknown");
  });
});

describe("readSandboxPortalLog", () => {
  test("returns the tail of the log and the kernel's out-of-memory kills", async () => {
    const lines = Array.from({ length: 50 }, (_, i) => `line ${i + 1}`);
    const { sandbox } = await fakeSandbox(`${lines.join("\n")}\n`);
    const read = await readSandboxPortalLog({
      sessionId: "session-a",
      sandbox,
      name: "web",
      lines: 3,
    });
    expect(read.log).toBe("line 48\nline 49\nline 50");
    expect(read.oomKills).toHaveLength(1);
  });

  test("match keeps only the lines containing it, case-insensitively", async () => {
    const { sandbox } = await fakeSandbox(
      "[RESCRIPT] warning\n[NEXT] GET /videos 200\n[NEXT] fatal error: boom\n[RESCRIPT] warning\n",
      "",
    );
    const read = await readSandboxPortalLog({
      sessionId: "session-a",
      sandbox,
      name: "web",
      match: "[next]",
    });
    expect(read.log).toBe("[NEXT] GET /videos 200\n[NEXT] fatal error: boom");
    expect(read.oomKills).toEqual([]);
  });

  test("a Portal that never wrote a log reads as null, not as an error", async () => {
    const { sandbox } = await fakeSandbox(null, "");
    expect(
      await readSandboxPortalLog({
        sessionId: "session-a",
        sandbox,
        name: "web",
      }),
    ).toEqual({ log: null, oomKills: [] });
  });

  test("refuses a name that could leave the Portal log directory", async () => {
    const { sandbox, commands } = await fakeSandbox("x\n");
    await expect(
      readSandboxPortalLog({
        sessionId: "session-a",
        sandbox,
        name: "../../etc/passwd",
      }),
    ).rejects.toThrow("Portal names");
    expect(commands).toEqual([]);
  });
});

describe("formatPortalLog", () => {
  test("leads with the out-of-memory kill and strips color escapes", () => {
    const text = formatPortalLog("web", {
      log: "\x1b[0;35m[WEBAPP:NEXT]\x1b[0m ready",
      oomKills: [{ pid: 7, process: "next-server (v1)", rssMb: 5674 }],
    });
    expect(text).toBe(
      "Since the Sandbox booted, its kernel killed these processes for running out of memory: next-server (v1) (pid 7, 5674 MB).\nweb log (latest lines):\n[WEBAPP:NEXT] ready",
    );
  });

  test("says when nothing matched or nothing was written", () => {
    expect(formatPortalLog("web", { log: "", oomKills: [] }, "fatal")).toBe(
      'web log, lines matching "fatal":\n(no matching lines)',
    );
    expect(formatPortalLog("web", { log: null, oomKills: [] })).toBe(
      "web has not written a log yet.",
    );
  });

  test("keeps the end of a very long log", () => {
    const text = formatPortalLog("web", {
      log: `${"a".repeat(40_000)}END`,
      oomKills: [],
    });
    expect(text.endsWith("END")).toBe(true);
    expect(text.length).toBeLessThan(31_000);
  });

  test("describeOomKills is empty without kills", () => {
    expect(describeOomKills([])).toBe("");
  });
});

describe("read_portal_log tool", () => {
  test("reads a Sandbox Portal's log the agent's shell cannot reach", async () => {
    const { sandbox } = await fakeSandbox("[NEXT] fatal error: deadlock\n");
    const server = createPortalsMcpServer({
      sessionId: "session-a",
      worktreeDir: () => "/tmp",
      verifyEditorFixture: async () => {
        throw new Error("unused");
      },
      setDefaultPath: async () => ({}),
      sandbox: async () => sandbox,
      hasSandbox: () => true,
      runner: () => undefined,
    });
    const runtime = await createMcpRuntime({
      mcpServers: [],
      deniedToolIds: new Set(),
      inProcessMcp: { "opensession-portals": server },
    });
    runtimes.push(runtime);
    const response = (await runtime.callExact(
      "opensession-portals_read_portal_log",
      { name: "web", lines: 20 },
      { toolCallId: "read-log" },
    )) as { content: Array<{ text: string }> };
    const text = response.content.map((part) => part.text).join("\n");
    expect(text).toContain("running out of memory: next-server (v1)");
    expect(text).toContain("[NEXT] fatal error: deadlock");
  });
});

describe("list_portals while a Sandbox Portal start is pending", () => {
  test("reports the start instead of no Portals", async () => {
    const { sandbox } = await fakeSandbox(null, "");
    const operations = ((
      globalThis as typeof globalThis & {
        __opensessionSandboxPortalOperations?: Map<string, Promise<unknown>>;
      }
    ).__opensessionSandboxPortalOperations ??= new Map());
    operations.set(`${sandbox.id}:web`, new Promise(() => {}));
    try {
      const server = createPortalsMcpServer({
        sessionId: "session-a",
        worktreeDir: () => "/tmp",
        verifyEditorFixture: async () => {
          throw new Error("unused");
        },
        setDefaultPath: async () => ({}),
        sandbox: async () => sandbox,
        hasSandbox: () => true,
        runner: () => undefined,
      });
      const runtime = await createMcpRuntime({
        mcpServers: [],
        deniedToolIds: new Set(),
        inProcessMcp: { "opensession-portals": server },
      });
      runtimes.push(runtime);
      const response = (await runtime.callExact(
        "opensession-portals_list_portals",
        {},
        { toolCallId: "list-pending" },
      )) as { content: Array<{ text: string }> };
      const text = response.content.map((part) => part.text).join("\n");
      expect(text).toContain("web\nstate: starting");
      expect(text).toContain("Do not start it again.");
      expect(text).not.toContain("No Portals are registered");
    } finally {
      operations.delete(`${sandbox.id}:web`);
    }
  });
});

describe("sandboxPortProbeArgv", () => {
  test("macOS guests bound the probe without GNU timeout", () => {
    for (const provider of ["tart", "usecomputer"]) {
      const argv = sandboxPortProbeArgv(provider, 4000);
      expect(argv[0]).toBe("perl");
      expect(argv).not.toContain("timeout");
      expect(argv.slice(-3)).toEqual([
        "bash",
        "-c",
        "exec 3<>/dev/tcp/127.0.0.1/4000",
      ]);
    }
  });

  test("Linux guests keep timeout", () => {
    expect(sandboxPortProbeArgv("daytona", 4000).slice(0, 2)).toEqual([
      "timeout",
      "5",
    ]);
  });
});
