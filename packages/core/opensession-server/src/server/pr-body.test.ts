import { describe, expect, test } from "bun:test";
import {
  composePrBody,
  extractAgentPrBody,
  extractAgentSummary,
  findPrivateTerm,
  PR_BODY_SECTION_END,
  PR_BODY_SECTION_START,
  PR_BODY_SENTINEL,
  prAttributionFooter,
  sessionRefFromPrBody,
  spliceAgentPrBody,
} from "./pr-body";

describe("extractAgentPrBody", () => {
  test("reads only the reviewer-facing text between the sentinels", () => {
    const result = [
      "Working notes that stay private.",
      PR_BODY_SENTINEL,
      "## What changed",
      "Fixed the bug.",
      "IMPLEMENTATION_COMPLETE",
    ].join("\n");
    expect(extractAgentPrBody(result)).toBe("## What changed\nFixed the bug.");
  });

  test("returns an empty body when the agent did not emit a description", () => {
    expect(extractAgentPrBody("Implemented. IMPLEMENTATION_COMPLETE")).toBe("");
  });

  test("caps an oversized description", () => {
    const body = "x".repeat(70_000);
    const result = `${PR_BODY_SENTINEL}\n${body}\nIMPLEMENTATION_COMPLETE`;
    expect(extractAgentPrBody(result).length).toBeLessThan(60_100);
  });
});

describe("extractAgentSummary", () => {
  test("keeps the text before the PR body for the Linear timeline", () => {
    const result = `Short summary.\n${PR_BODY_SENTINEL}\n## What changed\nIMPLEMENTATION_COMPLETE`;
    expect(extractAgentSummary(result)).toBe("Short summary.");
  });

  test("strips a trailing completion marker when there is no body", () => {
    expect(extractAgentSummary("Implemented. IMPLEMENTATION_COMPLETE")).toBe(
      "Implemented.",
    );
  });
});

describe("composePrBody", () => {
  test("puts the agent's description first and the server blocks after it", () => {
    const footer = prAttributionFooter({
      sessionUrl: "https://app.example.test/session/linear-agent~abc",
      author: "Ada",
      persona: "Open Session",
    });
    const body = composePrBody({
      agentBody: "## What changed\nFixed the bug.",
      ticket: {
        identifier: "ENG-1",
        title: "Fix the bug",
        url: "https://linear.app/example/issue/ENG-1",
      },
      participants: ["Ada"],
      testPlan: ["Verify implementation meets acceptance criteria"],
      footer,
    });
    expect(body).toContain("## What changed");
    expect(body).toContain(PR_BODY_SECTION_START);
    expect(body).toContain(PR_BODY_SECTION_END);
    expect(body).toContain("## Ticket\nImplements ENG-1: Fix the bug");
    expect(body).toContain("https://linear.app/example/issue/ENG-1");
    expect(body).toContain("**Requested by:** Ada (via Linear)");
    expect(body).not.toContain("## Test plan");
    expect(body.trimEnd().endsWith(footer)).toBe(true);
  });

  test("keeps the summary and test plan when the agent wrote nothing", () => {
    const body = composePrBody({
      ticket: { identifier: "ENG-1", title: "Fix the bug" },
      testPlan: ["Verify implementation meets acceptance criteria"],
    });
    expect(body).toContain("## Summary\nImplements ENG-1: Fix the bug");
    expect(body).toContain("## Test plan");
    expect(body).toContain(
      "- [ ] Verify implementation meets acceptance criteria",
    );
  });
});

describe("findPrivateTerm", () => {
  test("matches case-insensitively and ignores short terms", () => {
    expect(
      findPrivateTerm("See ACME-INTERNAL.TEST", ["acme-internal.test"]),
    ).toBe("acme-internal.test");
    expect(findPrivateTerm("anything", ["ab"])).toBeUndefined();
  });
});

describe("sessionRefFromPrBody", () => {
  test("reads a Linear session id containing a tilde", () => {
    const footer = prAttributionFooter({
      sessionUrl: "https://app.example.test/session/linear-agent~abc",
      author: "Ada",
      persona: "Open Session",
    });
    expect(sessionRefFromPrBody(`Body\n\n${footer}`)).toBe("linear-agent~abc");
  });

  test("does not claim a body that only links to a session in passing", () => {
    expect(
      sessionRefFromPrBody("See https://app.example.test/session/os-123"),
    ).toBeUndefined();
  });
});

describe("spliceAgentPrBody", () => {
  test("replaces only the managed section", () => {
    const original = [
      `${PR_BODY_SECTION_START}`,
      "Old description",
      `${PR_BODY_SECTION_END}`,
      "",
      "A human note that must survive.",
      "Started by Ada in [this Open Session session](https://app.example.test/session/linear-agent~abc)",
    ].join("\n");
    const next = spliceAgentPrBody(original, "New description");
    expect(next).toContain("New description");
    expect(next).not.toContain("Old description");
    expect(next).toContain("A human note that must survive.");
    expect(next).toContain("linear-agent~abc");
  });

  test("never rewrites a body without the managed markers", () => {
    const human = "A human-written description.";
    expect(spliceAgentPrBody(human, "Agent rewrite")).toBe(human);
  });
});
