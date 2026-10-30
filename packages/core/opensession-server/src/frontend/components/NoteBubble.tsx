import React, { useEffect, useRef, useState } from "react";
import { markThreadSeenApi } from "../lib/api";
import {
  needsSeenMark,
  seenByLabel,
  seenLatest,
  sendThreadToSession,
} from "../lib/comment-threads";
import { noteSurface } from "../lib/tinted-surface";
import type { CommentThread } from "../lib/types";
import { Button } from "../ui/button";
import { Tooltip } from "../ui/tooltip";
import { CommentThreadView, commentTime } from "./comments/CommentThreadView";
import { IconCheck } from "./icons";
import { UserAvatar } from "./UserAvatar";
import { useCurrentUser } from "./UserPicker";

/**
 * A team note in the session transcript: a comment thread with no passage,
 * sitting in the timeline where it was posted. People talk to each other
 * here; the agent's run never sees it (src/server/comment-threads.ts). The
 * deliberate yellow tint keeps it from being mistaken for a prompt or an
 * answer.
 *
 * It takes replies, @-mentions, an assignee and a resolve state like any
 * thread. A resolved note folds to one line so the timeline stays readable.
 * Under the comments a read receipt says who has seen the newest one.
 */
export function NoteBubble({
  thread,
  sessionId,
}: {
  thread: CommentThread;
  /** Absent in read-only hosts (the sub-agent pane): no actions, no replies. */
  sessionId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  const root = thread.comments[0]!;
  const folded = thread.status === "resolved" && !expanded;
  const ref = useRef<HTMLDivElement>(null);
  useMarkSeen(ref, thread, folded ? undefined : sessionId);

  return (
    <div
      ref={ref}
      // A note is a transcript block like any other, so it takes the same
      // centered reading column the turns and cards use (mx-auto +
      // --session-col) and the same mt-2/mb-6 rhythm.
      className="relative mx-auto mb-6 mt-2 w-full max-w-[var(--session-col)] rounded-2xl px-4 py-3.5"
      style={{ background: noteSurface("transparent") }}
      data-note-thread={thread.id}
    >
      {folded ? (
        <div className="flex min-w-0 items-center gap-2 text-supporting text-dim">
          <IconCheck size={16} className="shrink-0 text-faint" />
          <UserAvatar name={root.user} size={18} />
          <span className="min-w-0 truncate">
            <span className="font-semibold text-fg">{root.user}</span>
            {" · "}
            {root.text.replace(/\s+/g, " ")}
          </span>
          <span className="shrink-0 text-meta text-faint">
            {commentTime(root.ts)}
            {thread.comments.length > 1
              ? ` · ${thread.comments.length - 1} ${thread.comments.length === 2 ? "reply" : "replies"}`
              : ""}
          </span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setExpanded(true)}
            className="ml-auto shrink-0 phone:min-h-11"
          >
            Show
          </Button>
        </div>
      ) : sessionId ? (
        <CommentThreadView
          thread={thread}
          sessionId={sessionId}
          rootLabel={<NoteTag />}
          onSendToSession={(t) => sendThreadToSession(sessionId, t)}
          onResolved={() => setExpanded(false)}
          footer={<NoteSeen thread={thread} />}
        />
      ) : (
        <ReadOnlyNote thread={thread} />
      )}
    </div>
  );
}

/** How long a note must stay on screen before it counts as seen. */
const SEEN_DWELL_MS = 1000;

/**
 * Send my read receipt once the note has been on screen for a moment, in a
 * visible tab. Only when the newest comment is someone else's and my last
 * receipt predates it, so scrolling past a note I already saw costs nothing.
 */
function useMarkSeen(
  ref: React.RefObject<HTMLDivElement | null>,
  thread: CommentThread,
  sessionId: string | undefined,
) {
  const me = useCurrentUser();
  const owed = !!sessionId && needsSeenMark(thread, me);
  // One request per newest comment, even while its echo is in flight.
  const sentFor = useRef<string | null>(null);
  const latestKey = `${thread.comments.at(-1)?.id}:${thread.comments.length}`;

  useEffect(() => {
    const node = ref.current;
    if (!owed || !sessionId || !node || sentFor.current === latestKey) return;
    if (typeof IntersectionObserver === "undefined") return;
    let onScreen = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      clearTimeout(timer);
      if (!onScreen || document.visibilityState !== "visible") return;
      timer = setTimeout(() => {
        sentFor.current = latestKey;
        markThreadSeenApi(sessionId, thread.id, me).catch(() => {
          sentFor.current = null;
        });
      }, SEEN_DWELL_MS);
    };
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!entry) return;
        const viewport = entry.rootBounds?.height ?? window.innerHeight;
        // Half the note, or half the screen for a note taller than it.
        onScreen =
          entry.isIntersecting &&
          (entry.intersectionRatio >= 0.5 ||
            entry.intersectionRect.height >= viewport / 2);
        settle();
      },
      { threshold: [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.75, 1] },
    );
    observer.observe(node);
    document.addEventListener("visibilitychange", settle);
    return () => {
      clearTimeout(timer);
      observer.disconnect();
      document.removeEventListener("visibilitychange", settle);
    };
  }, [owed, sessionId, thread.id, me, latestKey, ref]);
}

/**
 * The read receipt under a note: who has seen the newest comment. When that
 * comment is mine and nobody has, it says so, which is the case the receipt
 * exists for.
 */
function NoteSeen({ thread }: { thread: CommentThread }) {
  const me = useCurrentUser();
  const seen = seenLatest(thread);
  const latest = thread.comments.at(-1);
  if (!seen.length) {
    if (!latest || latest.user.trim().toLowerCase() !== me.trim().toLowerCase())
      return null;
    return <div className="pl-7 text-meta text-faint">Not seen yet</div>;
  }
  const names = seen.map((s) => s.user);
  return (
    <div className="pl-7">
      <Tooltip
        multiline
        side="bottom"
        align="start"
        label={
          <span className="flex flex-col">
            {seen.map((s) => (
              <span key={s.user}>
                {s.user} · {commentTime(s.ts)}
              </span>
            ))}
          </span>
        }
      >
        <div
          className="flex w-fit max-w-full items-center gap-1.5 text-meta text-faint"
          tabIndex={0}
          aria-label={`Seen by ${names.join(", ")}`}
        >
          <span className="flex shrink-0 -space-x-1">
            {seen.slice(0, 3).map((s) => (
              <UserAvatar key={s.user} name={s.user} size={14} />
            ))}
          </span>
          <span className="truncate">Seen by {seenByLabel(names)}</span>
        </div>
      </Tooltip>
    </div>
  );
}

function NoteTag() {
  return (
    <span
      className="shrink-0 text-meta font-semibold"
      style={{ color: "var(--yellow)" }}
      title="Only the team sees this note"
    >
      Note
    </span>
  );
}

function ReadOnlyNote({ thread }: { thread: CommentThread }) {
  return (
    <div className="flex flex-col gap-3">
      {thread.comments.map((comment, index) => (
        <div key={comment.id} className="flex flex-col gap-1">
          <div className="flex items-center gap-2">
            <UserAvatar name={comment.user} size={20} />
            <span className="text-supporting font-semibold text-fg">
              {comment.user}
            </span>
            {index === 0 && <NoteTag />}
            <span className="text-meta text-faint">
              {commentTime(comment.ts)}
            </span>
          </div>
          <div className="whitespace-pre-wrap break-words pl-7 text-body leading-relaxed text-fg">
            {comment.text}
          </div>
        </div>
      ))}
    </div>
  );
}
