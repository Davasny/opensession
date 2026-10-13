import { describe, expect, test } from "bun:test";
import {
  STRIPE_APPROVAL_SESSION_MARKER,
  guardStripeApprovalCall,
  stampApprovalReason,
} from "./stripe-approvals";
import { runToolPolicy } from "./run-policy";
import { STRIPE_CONFIRM_TOOLS } from "./runner-shared";

const URL = "https://os.example.test/session/os-abc";

describe("guardStripeApprovalCall", () => {
  const write = { server: "stripe", name: "stripe_api_write" };

  test("lets refunds through unchanged", () => {
    const args = {
      stripe_api_operation_id: "PostRefunds",
      parameters: { charge: "ch_1", amount: 1000 },
    };
    expect(guardStripeApprovalCall(write, args, URL)).toEqual(args);
  });

  test("rejects writes Stripe cannot hold for approval", () => {
    for (const op of [
      "PostCharges",
      "PostPaymentIntents",
      "PostSubscriptionsSubscriptionExposedId",
      undefined,
    ])
      expect(() =>
        guardStripeApprovalCall(
          write,
          { stripe_api_operation_id: op, parameters: {} },
          URL,
        ),
      ).toThrow(/not allowed/);
    expect(() =>
      guardStripeApprovalCall(
        { server: "stripe", name: "stripe_api_execute" },
        { stripe_api_operation_id: "PostCustomers" },
        URL,
      ),
    ).toThrow(/not allowed/);
  });

  test("stamps the session link onto approval-request reasons", () => {
    const out = guardStripeApprovalCall(
      write,
      {
        stripe_api_operation_id: "PostV2CoreApprovalRequestsId",
        parameters: { id: "apreq_1", reason: "Refund $10 test" },
      },
      URL,
    ) as { parameters: { reason: string; id: string } };
    expect(out.parameters.id).toBe("apreq_1");
    expect(out.parameters.reason).toBe(
      `Refund $10 test\n\n${STRIPE_APPROVAL_SESSION_MARKER} ${URL}`,
    );
  });

  test("leaves other servers and read tools alone", () => {
    const args = { stripe_api_operation_id: "PostCharges" };
    expect(
      guardStripeApprovalCall(
        { server: "acme", name: "stripe_api_write" },
        args,
        URL,
      ),
    ).toBe(args);
    expect(
      guardStripeApprovalCall(
        { server: "stripe", name: "stripe_api_read" },
        args,
        URL,
      ),
    ).toBe(args);
  });
});

describe("stampApprovalReason", () => {
  test("is idempotent and stays within Stripe's 1000 characters", () => {
    const once = stampApprovalReason("x".repeat(2000), URL);
    expect(once.length).toBeLessThanOrEqual(1000);
    expect(once.endsWith(URL)).toBe(true);
    expect(stampApprovalReason(once, URL)).toBe(once);
    expect(stampApprovalReason(undefined, URL)).toBe(
      `${STRIPE_APPROVAL_SESSION_MARKER} ${URL}`,
    );
  });
});

describe("runToolPolicy stripeApprovals", () => {
  const denied = Object.fromEntries(
    Object.keys(STRIPE_CONFIRM_TOOLS).map((name) => [name, "no money here"]),
  );

  test("strips every money mover when approvals are off", () => {
    const policy = runToolPolicy({
      deniedTools: denied,
      confirmTools: STRIPE_CONFIRM_TOOLS,
      journalKind: "automation",
    });
    expect(policy.disables.stripe_stripe_api_write).toBe(false);
    expect(policy.disables.stripe_create_refund).toBe(false);
  });

  test("keeps the held tools for every run kind, never update_subscription", () => {
    for (const journalKind of ["prompt", "automation", "plain", "goal"]) {
      const policy = runToolPolicy({
        deniedTools: denied,
        confirmTools: STRIPE_CONFIRM_TOOLS,
        journalKind,
        stripeApprovals: true,
      });
      expect(policy.unattended).toBe(true);
      expect(policy.disables.stripe_stripe_api_write).toBeUndefined();
      expect(policy.disables.stripe_create_refund).toBeUndefined();
      expect(policy.disables.stripe_cancel_subscription).toBeUndefined();
      expect(policy.disables.stripe_update_subscription).toBe(false);
    }
  });
});
