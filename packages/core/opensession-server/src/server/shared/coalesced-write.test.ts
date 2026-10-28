import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { coalescedWriter } from "./coalesced-write";

const dir = mkdtempSync(join(tmpdir(), "coalesced-write-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

test("a burst of schedules writes the newest state, not once per call", async () => {
  const path = join(dir, "nested", "state.json");
  let value = 0;
  let renders = 0;
  const writer = coalescedWriter({
    path: () => path,
    render: () => {
      renders++;
      return JSON.stringify({ value });
    },
    label: "test",
  });
  for (let i = 1; i <= 50; i++) {
    value = i;
    writer.schedule();
  }
  await writer.flush();
  expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({ value: 50 });
  // One write started at once, and one more for everything after it.
  expect(renders).toBeLessThanOrEqual(2);
});

test("a delayed writer writes once the delay passes, or on flush", async () => {
  const path = join(dir, "delayed.json");
  let value = "a";
  const writer = coalescedWriter({
    path: () => path,
    render: () => value,
    delayMs: 60_000,
    label: "test",
  });
  writer.schedule();
  value = "b";
  writer.schedule();
  await writer.flush();
  expect(readFileSync(path, "utf8")).toBe("b");
});
