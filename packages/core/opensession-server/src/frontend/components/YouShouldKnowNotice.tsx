import { useState } from "react";
import { parseYouShouldKnowTitle } from "@tellahq/opensession-protocol/notices";
import { addYouShouldKnowTopic, saveYouShouldKnow } from "../lib/api";
import { errorMessage } from "../lib/error-message";
import { msgBody, msgSystemRow } from "../lib/msg-classes";
import type { TranscriptEntry } from "../lib/types";
import {
  requestYouShouldKnowChat,
  youShouldKnowChatText,
} from "../lib/you-should-know";
import { Button } from "../ui/button";
import { cn } from "../ui/cn";
import { toast } from "../ui/toast";
import {
  getYouShouldKnowUse,
  saveYouShouldKnowUse,
  youShouldKnowUseKey,
  type YouShouldKnowUse,
} from "../lib/you-should-know-used";
import { IconCheck } from "./icons";
import { ClampedBody } from "./MessageBubble";
import { getCurrentUser } from "./UserPicker";

/**
 * A You should know note (server/you-should-know.ts) with the plugin's
 * answers: Learn more opens the explanation, Ask about this quotes the note
 * into the composer (with the cursor there) so the main agent can answer,
 * I knew this tells later checks to skip the topic, and Turn off (pressed twice, as in the plugin) switches the side
 * agent off for this person. Once asked about or known, the card folds into
 * one muted line (remembered per device) that opens again on click; the
 * topic itself is remembered on the server.
 */
export function YouShouldKnowNotice({
  entry,
  sessionId,
}: {
  entry: TranscriptEntry;
  sessionId?: string;
}) {
  const notice = entry.notice!;
  const { tag, line } = parseYouShouldKnowTitle(notice.title);
  const explanation = notice.body ? entry.content : "";
  const useKey = youShouldKnowUseKey(sessionId, entry.id);
  const [use, setUseState] = useState<YouShouldKnowUse | undefined>(() =>
    getYouShouldKnowUse(useKey),
  );
  const [unfolded, setUnfolded] = useState(false);
  const [open, setOpen] = useState(false);
  const [known, setKnown] = useState(use !== undefined);
  const [offArmed, setOffArmed] = useState(false);
  const [off, setOff] = useState(false);

  function markUsed(next: YouShouldKnowUse | undefined) {
    setUseState(next);
    setUnfolded(false);
    setOpen(false);
    saveYouShouldKnowUse(useKey, next);
  }

  async function remember(quiet = false) {
    setKnown(true);
    if (!quiet) markUsed("known");
    try {
      await addYouShouldKnowTopic(getCurrentUser(), line);
    } catch (error) {
      setKnown(false);
      if (quiet) return;
      markUsed(undefined);
      toast(errorMessage(error, "Failed to save"), { variant: "error" });
    }
  }

  // As in the plugin, asking about a note also counts as having seen it, so
  // the same topic is not offered again.
  function ask() {
    if (!sessionId) return;
    requestYouShouldKnowChat(
      sessionId,
      youShouldKnowChatText(tag, line, explanation),
    );
    markUsed(use ?? "asked");
    if (!known) void remember(true);
  }

  async function turnOff() {
    if (!offArmed) {
      setOffArmed(true);
      return;
    }
    try {
      await saveYouShouldKnow(getCurrentUser(), false);
      setOff(true);
      toast("You should know is off. Turn it back on in Settings.");
    } catch (error) {
      setOffArmed(false);
      toast(errorMessage(error, "Failed to turn off You should know"), {
        variant: "error",
      });
    }
  }

  if (use && !unfolded) {
    return (
      <div className={msgSystemRow} data-eid={entry.id}>
        <Button
          size="sm"
          variant="ghost"
          className="mx-auto flex w-full max-w-[560px] justify-start font-normal text-faint"
          icon={<IconCheck />}
          trailing={use === "asked" ? "Asked" : "Known"}
          onClick={() => setUnfolded(true)}
        >
          <span className="min-w-0 flex-1 truncate py-0.5 text-start">
            {tag} · {line}
          </span>
        </Button>
      </div>
    );
  }

  return (
    <div className={msgSystemRow} data-eid={entry.id}>
      <div
        className="mx-auto w-full max-w-[560px] rounded-lg bg-panel px-4 py-3 text-left"
        role="group"
        aria-label={tag}
      >
        <div className="text-meta font-medium text-faint">{tag}</div>
        <p className="mt-0.5 text-sm text-fg">{line}</p>
        {open && explanation && (
          <ClampedBody
            className={cn(msgBody, "markdown mt-2")}
            content={explanation}
            entry={entry}
            sessionId={sessionId}
          />
        )}
        <div className="mt-2.5 flex flex-wrap items-center gap-1.5">
          {explanation && (
            <Button
              size="sm"
              variant="soft"
              aria-expanded={open}
              onClick={() => setOpen((value) => !value)}
            >
              {open ? "Hide" : "Learn more"}
            </Button>
          )}
          {sessionId && (
            <Button size="sm" variant="soft" onClick={ask}>
              Ask about this
            </Button>
          )}
          {!known && (
            <Button size="sm" variant="ghost" onClick={() => void remember()}>
              I knew this
            </Button>
          )}
          {use && (
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setUnfolded(false)}
            >
              Fold
            </Button>
          )}
          {!off && (
            <Button
              size="sm"
              variant="ghost"
              className="phone:ms-0 ms-auto text-faint"
              onClick={turnOff}
              onBlur={() => setOffArmed(false)}
            >
              {offArmed ? "Press again to turn off" : "Turn off"}
            </Button>
          )}
        </div>
      </div>
    </div>
  );
}
