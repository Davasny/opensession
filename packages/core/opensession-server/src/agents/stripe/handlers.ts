/**
 * Stripe webhook handlers.
 *
 * `v2.core.approval_request.*` thin events go to approvals.ts (Slack and the
 * requesting session). Otherwise the only event we act on is
 * `charge.dispute.created` — a chargeback was filed.
 * We fire the `stripe:charge.dispute.created` automation event with the dispute's
 * identifiers and headline facts. The investigation automation treats Stripe as
 * source of truth and re-fetches the full dispute itself via the Stripe MCP, so
 * we deliberately forward a small payload (no 10KB-truncation risk) rather than
 * the whole event object.
 */

import { APPROVAL_EVENT_PREFIX, handleApprovalEvent } from "./approvals";

export const DISPUTE_CREATED_EVENT = "stripe:charge.dispute.created";

interface StripeDispute {
  id: string;
  amount?: number;
  currency?: string;
  reason?: string;
  status?: string;
  charge?: string | { id?: string };
  payment_intent?: string | { id?: string } | null;
  created?: number;
  evidence_details?: { due_by?: number | null } | null;
}

interface StripeEvent {
  id: string;
  type: string;
  livemode?: boolean;
  data?: { object?: StripeDispute };
  /** Thin (v2) events name their object here instead of carrying it. */
  related_object?: { id?: string; type?: string; url?: string } | null;
}

function idOf(
  value: string | { id?: string } | null | undefined,
): string | null {
  if (!value) return null;
  return typeof value === "string" ? value : (value.id ?? null);
}

/**
 * Parse a verified Stripe event and, for a created dispute, fire the automation
 * event. Returns the number of automations fired (0 for ignored event types).
 */
export async function handleStripeEvent(event: StripeEvent): Promise<number> {
  if (event.type?.startsWith(APPROVAL_EVENT_PREFIX)) {
    await handleApprovalEvent(event);
    return 0;
  }
  if (event.type !== "charge.dispute.created") {
    console.log(`[stripe] Ignoring event ${event.type}`);
    return 0;
  }

  const dispute = event.data?.object;
  if (!dispute?.id) {
    console.error("[stripe] charge.dispute.created with no dispute object");
    return 0;
  }

  const payload = {
    source: "stripe-webhook",
    eventId: event.id,
    livemode: event.livemode ?? false,
    disputeId: dispute.id,
    reason: dispute.reason ?? null,
    status: dispute.status ?? null,
    amount: dispute.amount ?? null,
    currency: dispute.currency ?? null,
    dueBy: dispute.evidence_details?.due_by ?? null,
    charge: idOf(dispute.charge),
    paymentIntent: idOf(dispute.payment_intent),
    created: dispute.created ?? null,
  };

  const { fireAutomationsForEvent } = await import("../../server/automations");
  const fired = await fireAutomationsForEvent(
    DISPUTE_CREATED_EVENT,
    JSON.stringify(payload, null, 2),
  );
  console.log(
    `[stripe] Dispute ${dispute.id} (${dispute.reason ?? "?"}) → fired ${fired} automation(s)`,
  );
  return fired;
}
