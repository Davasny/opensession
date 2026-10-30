import React, { useEffect, useState } from "react";
import { msgSystemRow } from "../lib/msg-classes";
import {
  getSessionContextRowPref,
  onSessionContextRowChanged,
} from "../lib/session-context-pref";
import { SessionContextMessage } from "./SessionContextMessage";
import { TranscriptLoadingStatus } from "./TranscriptLoadingStatus";

/** The transcript's top slot. The session context row is a debugging aid,
 * shown only with its Debug preference on; otherwise the slot holds just the
 * history-loading status while older entries load, and nothing after. */
export function SessionContextSlot({
  sessionId,
  historyLoading = false,
}: {
  sessionId: string;
  historyLoading?: boolean;
}) {
  const [shown, setShown] = useState(getSessionContextRowPref);
  useEffect(
    () =>
      onSessionContextRowChanged(() => setShown(getSessionContextRowPref())),
    [],
  );
  if (shown)
    return (
      <SessionContextMessage
        sessionId={sessionId}
        historyLoading={historyLoading}
      />
    );
  if (!historyLoading) return null;
  return (
    <div className={msgSystemRow} data-session-context>
      <TranscriptLoadingStatus />
    </div>
  );
}
