import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { getConfigAsync } from "../../server/config";
import { sessionLink } from "../../server/run-instructions";
import { STRIPE_APPROVAL_SESSION_MARKER } from "../../server/stripe-approvals";
import {
  approvalOutcome,
  approvalSessionId,
  handleApprovalEvent,
  slackApprovalText,
} from "./approvals";

const saved = {
  config: process.env.OPENSESSION_CONFIG,
  key: process.env.STRIPE_API_KEY,
};
const dirs: string[] = [];

async function withConfig(obj: unknown): Promise<void> {
  const dir = mkdtempSync(join(tmpdir(), "stripe-approvals-test-"));
  dirs.push(dir);
  const path = join(dir, "config.json");
  writeFileSync(path, JSON.stringify(obj));
  process.env.OPENSESSION_CONFIG = path;
  await getConfigAsync();
}

afterEach(() => {
  const restore = (k: string, v: string | undefined) =>
    v === undefined ? delete process.env[k] : (process.env[k] = v);
  restore("OPENSESSION_CONFIG", saved.config);
  restore("STRIPE_API_KEY", saved.key);
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

const marker = (id: string) =>
  `${STRIPE_APPROVAL_SESSION_MARKER} ${sessionLink(id)}`;

function request(reason: string) {
  return {
    id: "apreq_abc",
    action: "refund.create",
    status: "requires_review",
    reason,
    dashboard_url:
      "https://dashboard.stripe.com/settings/approvals/requests/apreq_abc",
    expires_at: "2026-10-14T21:06:34.000Z",
  };
}

describe("approval events", () => {
  test("parse outcomes and only this server's session marker", () => {
    expect(approvalOutcome("v2.core.approval_request.succeeded")).toBe(
      "succeeded",
    );
    expect(approvalOutcome("v2.core.approval_request.bogus")).toBeNull();
    expect(approvalOutcome("charge.refunded")).toBeNull();
    expect(approvalSessionId(`Refund\n\n${marker("os-1")}`)).toBe("os-1");
    expect(
      approvalSessionId(
        `${STRIPE_APPROVAL_SESSION_MARKER} https://evil.example.test/session/os-2`,
      ),
    ).toBeNull();
    // The server's stamp is last, so it wins over a link written in the text.
    expect(approvalSessionId(`${marker("os-x")}\n${marker("os-real")}`)).toBe(
      "os-real",
    );
  });

  test("Slack text escapes the reason and drops the marker", () => {
    const text = slackApprovalText(
      "created",
      request(`<!channel> refund $10\n\n${marker("os-1")}`),
      "os-1",
    );
    expect(text).toContain("Refund needs review");
    expect(text).toContain("&lt;!channel&gt; refund $10");
    expect(text).not.toContain(STRIPE_APPROVAL_SESSION_MARKER);
    expect(text).toContain("2026-10-14 21:06:34 UTC");
  });

  test("posts to Slack and tells the requesting session when settled", async () => {
    await withConfig({
      integrations: { stripe: { approvalsSlackChannel: "C0123" } },
    });
    process.env.STRIPE_API_KEY = "rk_test_example";
    const posts: Array<[string, string, string | undefined]> = [];
    const delivered: Array<[string, string]> = [];
    const deps = {
      fetchImpl: (async () =>
        Response.json(request(`Refund $10\n\n${marker("os-1")}`))) as any,
      postSlack: async (c: string, t: string, ts?: string) => {
        posts.push([c, t, ts]);
        return "171.1";
      },
      deliver: async (id: string, t: string) => {
        delivered.push([id, t]);
        return true;
      },
    };
    const related = { id: "apreq_abc", type: "v2.core.approval_request" };
    expect(
      await handleApprovalEvent(
        {
          id: "evt_1",
          type: "v2.core.approval_request.created",
          related_object: related,
        },
        deps,
      ),
    ).toEqual({ slack: true, session: null });
    expect(
      await handleApprovalEvent(
        {
          id: "evt_2",
          type: "v2.core.approval_request.succeeded",
          related_object: related,
        },
        deps,
      ),
    ).toEqual({ slack: true, session: "os-1" });
    // A redelivered event is ignored.
    await handleApprovalEvent(
      {
        id: "evt_2",
        type: "v2.core.approval_request.succeeded",
        related_object: related,
      },
      deps,
    );
    expect(posts.length).toBe(2);
    expect(posts[1]![2]).toBe("171.1");
    expect(delivered).toHaveLength(1);
    expect(delivered[0]![1]).toContain("went through");
  });

  test("ignores events that do not name an approval request", async () => {
    const out = await handleApprovalEvent({
      id: "evt_3",
      type: "v2.core.approval_request.created",
      related_object: { id: "ch_123" },
    });
    expect(out).toEqual({ slack: false, session: null });
  });
});
