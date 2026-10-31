/**
 * Durable Linear integration messages in the unified transcript.
 *
 * Greeting and direction replies are written through the same actor append RPC
 * the runner uses. Stable entry ids make a webhook replay an upsert, and the
 * prompted run passes the same id plus the raw display text to the engine, so
 * the transformed planning/implementation prompt never replaces the person's
 * message.
 */
import { createHash, randomUUID } from "node:crypto";
import { appendTranscriptEvents } from "../../server/actor-transcript";
import type { AppendResult } from "../../server/transcript-store";
import type { TranscriptEntry } from "../../server/types";

export function linearGreetingEntry(input: {
  agentSessionId: string;
  text: string;
  timestamp: string;
}): TranscriptEntry {
  return {
    id: `linear-greeting:${input.agentSessionId}`,
    type: "assistant",
    content: input.text,
    timestamp: input.timestamp,
  };
}

export function linearUserEntry(input: {
  agentSessionId: string;
  activityId: string | null;
  text: string;
  timestamp: string;
  sourceTimestamp: string | null;
  userId: string | null;
}): TranscriptEntry {
  const digest = input.sourceTimestamp
    ? createHash("sha256")
        .update(
          `${input.userId ?? ""}\0${input.sourceTimestamp}\0${input.text}`,
          "utf8",
        )
        .digest("hex")
        .slice(0, 24)
    : randomUUID();
  const eventId = input.activityId || `${input.agentSessionId}:${digest}`;
  return {
    id: `linear-activity:${eventId}`,
    type: "user",
    content: input.text,
    timestamp: input.timestamp,
  };
}

export async function appendLinearTranscript(
  unifiedSessionId: string,
  entry: TranscriptEntry,
): Promise<AppendResult | null> {
  return appendTranscriptEvents(unifiedSessionId, [entry]);
}
