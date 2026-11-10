import { expect, test } from "bun:test";
import {
  agentSessionWebhookSchema,
  issueWebhookSchema,
} from "./webhook-schema";

const issue = {
  id: "issue-1",
  identifier: "ENG-1",
  title: "Write a guide",
  url: "https://linear.app/acme/issue/ENG-1",
};

test("normalizes the Linear agent event category and nullable description", () => {
  const parsed = agentSessionWebhookSchema.safeParse({
    type: "AgentSessionEvent",
    action: "created",
    organizationId: "org-1",
    agentSession: {
      id: "session-1",
      status: "active",
      issue: { ...issue, description: null },
    },
  });
  expect(parsed.success).toBe(true);
  if (parsed.success) {
    expect(parsed.data.type).toBe("AgentSession");
    expect(parsed.data.agentSession.issue.description).toBeUndefined();
  }
});

test("rejects malformed events before lifecycle handlers see them", () => {
  for (const value of [
    null,
    [],
    {},
    {
      type: "AgentSession",
      action: "created",
      organizationId: "org-1",
      agentSession: { id: "session-1" },
    },
  ]) {
    expect(agentSessionWebhookSchema.safeParse(value).success).toBe(false);
  }
  expect(
    issueWebhookSchema.safeParse({
      type: "Issue",
      action: "update",
      organizationId: "org-1",
      data: { ...issue, id: 1 },
    }).success,
  ).toBe(false);
});
