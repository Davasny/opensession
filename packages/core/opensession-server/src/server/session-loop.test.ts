import { describe, expect, test } from "bun:test";
import {
  describeLoop,
  loopExpired,
  loopTickNote,
  parseLoopCommand,
} from "./session-loop";
import { loopCommandFor } from "./schedule-mcp";

describe("parseLoopCommand", () => {
  test("reads an interval and a prompt", () => {
    expect(parseLoopCommand("30m check CI")).toEqual({
      intervalMinutes: 30,
      prompt: "check CI",
    });
  });

  test("reads an optional duration in minutes or hours", () => {
    expect(parseLoopCommand("15m for 2h check the queue")).toEqual({
      intervalMinutes: 15,
      forMinutes: 120,
      prompt: "check the queue",
    });
    expect(parseLoopCommand("1h for 90m check")).toMatchObject({
      intervalMinutes: 60,
      forMinutes: 90,
    });
  });

  test("keeps a prompt that merely starts with 'for'", () => {
    expect(parseLoopCommand("10m for each PR, check CI")).toEqual({
      intervalMinutes: 10,
      prompt: "for each PR, check CI",
    });
  });

  test("raises short intervals and caps long durations", () => {
    expect(parseLoopCommand("1m for 48h go")).toMatchObject({
      intervalMinutes: 5,
      forMinutes: 24 * 60,
    });
  });

  test("rejects input without a prompt", () => {
    expect(parseLoopCommand("15m")).toBeNull();
    expect(parseLoopCommand("soon check")).toBeNull();
  });
});

describe("loop timing", () => {
  test("describes the end time in UTC", () => {
    expect(
      describeLoop({ intervalMinutes: 5, until: "2026-10-16T07:30:00.000Z" }),
    ).toBe("every 5m until 07:30 UTC");
    expect(describeLoop({ intervalMinutes: 5 })).toBe("every 5m");
  });

  test("expires only once its end time passes", () => {
    const until = "2026-10-16T07:30:00.000Z";
    expect(loopExpired({ until }, Date.parse(until) - 1)).toBe(false);
    expect(loopExpired({ until }, Date.parse(until))).toBe(true);
    expect(loopExpired({})).toBe(false);
  });

  test("tells the model each answer is the update and how to stop", () => {
    const note = loopTickNote({ intervalMinutes: 5 });
    expect(note).toContain("final answer");
    expect(note).toContain("`cancel_scheduled_prompt` id `loop`");
  });
});

describe("loopCommandFor", () => {
  test("turns every/for minutes into a bounded /loop command", () => {
    expect(
      loopCommandFor({ every_minutes: 5, for_minutes: 120, prompt: " go " }),
    ).toEqual({ command: "/loop 5m for 120m go" });
  });

  test("needs both bounds and no one-off time", () => {
    expect(loopCommandFor({ every_minutes: 5, prompt: "go" })).toHaveProperty(
      "error",
    );
    expect(
      loopCommandFor({
        every_minutes: 5,
        for_minutes: 60,
        in_minutes: 5,
        prompt: "go",
      }),
    ).toHaveProperty("error");
    expect(
      loopCommandFor({ every_minutes: 2, for_minutes: 60, prompt: "go" }),
    ).toHaveProperty("error");
  });
});
