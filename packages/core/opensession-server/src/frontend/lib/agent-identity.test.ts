import { expect, test } from "bun:test";
import { agentIdentity } from "./agent-identity";

test("identities are deterministic across historical and current session IDs", () => {
  for (const id of [
    "os-00000000-0000-7000-8000-000000000001",
    "bks-demo-pr",
    "legacy-session",
  ]) {
    expect(agentIdentity(id)).toEqual(agentIdentity(id));
    expect(agentIdentity(id).name).toMatch(/^[A-Z][a-z]+ [A-Z][a-z]+$/);
  }
  // Ordered vocabularies and hash domains are a compatibility contract.
  expect(agentIdentity("bks-demo-pr")).toMatchSnapshot();
});

test("uses the full identifier and distributes thousands of agents", () => {
  const names = new Set<string>();
  for (let i = 0; i < 10000; i++) {
    const identity = agentIdentity(`os-00000000-0000-7000-8000-${i}`);
    names.add(identity.name);
  }
  expect(names.size).toBeGreaterThan(9950);
});

test("workers inherit only the root surname, keeping their own first name", () => {
  const parent = agentIdentity("main");
  const worker = agentIdentity("worker");
  const family = agentIdentity("worker", "main");
  expect(family.name.split(" ")[0]).toBe(worker.name.split(" ")[0]);
  expect(family.name.split(" ")[1]).toBe(parent.name.split(" ")[1]);
  expect(agentIdentity("peer").name.split(" ")[1]).not.toBe(
    parent.name.split(" ")[1],
  );
});
