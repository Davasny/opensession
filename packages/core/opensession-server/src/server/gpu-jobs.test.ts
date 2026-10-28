import { describe, expect, test } from "bun:test";
import {
  gpuJobEndedMessage,
  gpuMachineOwner,
  gpuMachineSessionId,
  isGpuJobMachine,
  MAX_GPU_JOB_MINUTES,
  parseRepoGpuJobs,
  pickGpuMachine,
  type GpuJobRecord,
} from "./gpu-jobs";

describe("repository GPU job declarations", () => {
  test("keeps well-formed jobs and fills defaults", () => {
    const jobs = parseRepoGpuJobs(
      JSON.stringify({
        jobs: {
          "gpu-tests": {
            command: "scripts/gpu-tests.sh",
            gpu: "l4",
            timeoutMinutes: 9999,
            description: "Render tests",
          },
          quick: { command: "nvidia-smi" },
          "bad name!": { command: "true" },
          empty: { command: "  " },
        },
      }),
    );
    expect(jobs).toEqual({
      "gpu-tests": {
        command: "scripts/gpu-tests.sh",
        gpu: "L4",
        timeoutMinutes: MAX_GPU_JOB_MINUTES,
        description: "Render tests",
      },
      quick: { command: "nvidia-smi", gpu: "T4", timeoutMinutes: 60 },
    });
  });

  test("a malformed file declares nothing", () => {
    expect(parseRepoGpuJobs("{")).toEqual({});
    expect(parseRepoGpuJobs('{"jobs":[]}')).toEqual({});
  });
});

describe("GPU job machine ids", () => {
  test("map back to their session", () => {
    expect(gpuMachineSessionId("os-1")).toBe("os-1--gpu");
    expect(isGpuJobMachine("md-os-1--gpu")).toBe(true);
    expect(isGpuJobMachine("md-os-1")).toBe(false);
    expect(gpuMachineOwner("md-os-1--gpu")).toBe("os-1");
    expect(gpuMachineOwner("md-os-1--portals")).toBeNull();
  });

  test("parallel jobs' machines map back too", () => {
    expect(gpuMachineSessionId("os-1", 1)).toBe("os-1--gpu");
    expect(gpuMachineSessionId("os-1", 2)).toBe("os-1--gpu-2");
    expect(isGpuJobMachine("md-os-1--gpu-2")).toBe(true);
    expect(isGpuJobMachine("md-os-1--gpu-x")).toBe(false);
    expect(gpuMachineOwner("md-os-1--gpu-12")).toBe("os-1");
  });
});

describe("choosing a GPU machine for a new job", () => {
  let at = 0;
  const record = (
    patch: Partial<GpuJobRecord> & Pick<GpuJobRecord, "state">,
  ): GpuJobRecord => ({
    id: `gj-${++at}`,
    sessionId: "os-1",
    title: "t",
    command: "x",
    gpu: "T4",
    startedAt: new Date(Date.UTC(2026, 9, 28, 10, at)).toISOString(),
    deadlineAt: "2026-10-28T23:00:00.000Z",
    ...patch,
  });

  test("the first job gets the first machine", () => {
    expect(pickGpuMachine([], "os-1", "T4")).toBe("os-1--gpu");
  });

  test("a job running on a machine sends the next one to a new machine", () => {
    const jobs = [record({ state: "running" })];
    expect(pickGpuMachine(jobs, "os-1", "T4")).toBe("os-1--gpu-2");
    // Records from before machines were numbered ran on the first one.
    expect(pickGpuMachine(jobs, "os-2", "T4")).toBe("os-2--gpu");
  });

  test("a free machine is reused, the one that ran this GPU first", () => {
    const jobs = [
      record({ state: "exited", machine: "os-1--gpu", gpu: "L4" }),
      record({ state: "exited", machine: "os-1--gpu-2", gpu: "T4" }),
      record({ state: "exited", machine: "os-1--gpu-3", gpu: "L4" }),
      record({ state: "preparing", machine: "os-1--gpu-4", gpu: "T4" }),
    ];
    expect(pickGpuMachine(jobs, "os-1", "T4")).toBe("os-1--gpu-2");
    // Of two free L4 machines, the most recently used.
    expect(pickGpuMachine(jobs, "os-1", "L4")).toBe("os-1--gpu-3");
  });

  test("every machine busy: another machine, however many run", () => {
    const jobs = Array.from({ length: 12 }, (_, i) =>
      record({
        state: "running",
        machine: gpuMachineSessionId("os-1", i + 1),
      }),
    );
    expect(pickGpuMachine(jobs, "os-1", "T4")).toBe("os-1--gpu-13");
  });

  test("a machine whose job records were pruned is reused before a new one", () => {
    const jobs = [record({ state: "running", machine: "os-1--gpu" })];
    expect(
      pickGpuMachine(jobs, "os-1", "T4", ["os-1--gpu", "os-1--gpu-3"]),
    ).toBe("os-1--gpu-3");
    // Every known machine busy: a new one skips the numbers they hold.
    expect(
      pickGpuMachine(
        [...jobs, record({ state: "running", machine: "os-1--gpu-3" })],
        "os-1",
        "T4",
        ["os-1--gpu", "os-1--gpu-3"],
      ),
    ).toBe("os-1--gpu-2");
  });
});

describe("the message that wakes the session", () => {
  const job: GpuJobRecord = {
    id: "gj-1",
    sessionId: "os-1",
    title: "gpu-tests",
    command: "x",
    gpu: "T4",
    state: "exited",
    exitCode: 1,
    startedAt: "2026-10-26T10:00:00.000Z",
    endedAt: "2026-10-26T10:03:05.000Z",
    deadlineAt: "2026-10-26T11:00:00.000Z",
    commit: "0123456789abcdef",
    logPath: "/scratch/gpu-jobs/gj-1.log",
  };

  test("says how it ended, where, and how it ended up", () => {
    const text = gpuJobEndedMessage(job, "test result: FAILED\n");
    expect(text).toContain(
      'GPU job "gpu-tests" (gj-1, T4) exited with code 1 after 3m 5s.',
    );
    expect(text).toContain("It ran on 0123456789ab.");
    expect(text).toContain("Full log: /scratch/gpu-jobs/gj-1.log");
    expect(text).toContain("Last output:\ntest result: FAILED");
  });

  test("a job that never ran reports its error, not an exit code", () => {
    const text = gpuJobEndedMessage(
      { ...job, state: "failed", error: "no capacity", logPath: undefined },
      "",
    );
    expect(text).toContain("could not run after");
    expect(text).toContain("Error: no capacity");
    expect(text).not.toContain("code 1");
  });
});
