import { describe, expect, test } from "bun:test";
import {
  applyAddComment,
  applyCreateThread,
  applyDeleteComment,
  applyEditComment,
  applyMarkSeen,
  applyUpdateThread,
  cleanAnchor,
  cleanThreads,
  threadParticipants,
  threadsFromNotes,
  type CommentThread,
} from "./comment-threads";
import {
  continuesAgentConversation,
  mentionsAgent,
  threadUrl,
} from "./comment-thread-service";

const anchor = {
  entryId: "entry-1",
  exact: "run it on Sunday",
  prefix: "we should ",
  suffix: " instead",
};

function created(
  threads: CommentThread[] = [],
  overrides: Partial<Parameters<typeof applyCreateThread>[1]> = {},
) {
  const result = applyCreateThread(threads, {
    sessionId: "os-1",
    user: "Ada",
    text: "Is Sunday OK?",
    anchor,
    now: 1000,
    ...overrides,
  });
  if (!result.ok) throw new Error(result.reason);
  return result;
}

describe("comment threads", () => {
  test("a new thread opens with its first comment and shares its id", () => {
    const { thread, threads } = created();
    expect(threads).toHaveLength(1);
    expect(thread.status).toBe("open");
    expect(thread.createdBy).toBe("Ada");
    expect(thread.comments).toHaveLength(1);
    expect(thread.comments[0]!.id).toBe(thread.id);
    expect(thread.anchor).toEqual(anchor);
  });

  test("an empty comment is refused", () => {
    expect(
      applyCreateThread([], { sessionId: "os-1", user: "Ada", text: "  " }),
    ).toEqual({ ok: false, reason: "empty" });
  });

  test("replies append and bump updatedAt", () => {
    const { thread, threads } = created();
    const reply = applyAddComment(threads, thread.id, {
      user: "Grace",
      text: "Saturday is better",
      now: 2000,
    });
    if (!reply.ok) throw new Error(reply.reason);
    expect(reply.thread.comments.map((c) => c.user)).toEqual(["Ada", "Grace"]);
    expect(reply.thread.updatedAt).toBe(2000);
    expect(reply.thread.added.text).toBe("Saturday is better");
  });

  test("an agent reply clears the pending marker", () => {
    const { thread, threads } = created();
    const pending = applyUpdateThread(
      threads,
      thread.id,
      { agentPending: true },
      "Agent",
      1500,
    );
    if (!pending.ok) throw new Error(pending.reason);
    expect(pending.thread.agentPendingSince).toBe(1500);
    const reply = applyAddComment(pending.threads, thread.id, {
      user: "Agent",
      text: "Sunday clashes with billing.",
      agent: true,
    });
    if (!reply.ok) throw new Error(reply.reason);
    expect(reply.thread.agentPendingSince).toBeUndefined();
    expect(reply.thread.added.agent).toBe(true);
  });

  test("only the author edits a comment, and never an agent's", () => {
    const { thread, threads } = created();
    expect(
      applyEditComment(threads, thread.id, thread.id, "changed", "Grace"),
    ).toEqual({ ok: false, reason: "not_author" });
    const edited = applyEditComment(
      threads,
      thread.id,
      thread.id,
      "changed",
      "ada",
      3000,
    );
    if (!edited.ok) throw new Error(edited.reason);
    expect(edited.thread.comments[0]!.text).toBe("changed");
    expect(edited.thread.comments[0]!.editedAt).toBe(3000);
  });

  test("deleting the first comment deletes the thread", () => {
    const { thread, threads } = created();
    const reply = applyAddComment(threads, thread.id, {
      user: "Grace",
      text: "ok",
    });
    if (!reply.ok) throw new Error(reply.reason);
    const deleted = applyDeleteComment(
      reply.threads,
      thread.id,
      thread.id,
      "Ada",
    );
    if (!deleted.ok) throw new Error(deleted.reason);
    expect(deleted.thread).toBeNull();
    expect(deleted.threads).toHaveLength(0);
    expect(deleted.removed).toHaveLength(2);
  });

  test("anyone may delete an agent comment, nobody else's", () => {
    const { thread, threads } = created();
    const agent = applyAddComment(threads, thread.id, {
      user: "Agent",
      text: "answer",
      agent: true,
    });
    if (!agent.ok) throw new Error(agent.reason);
    const commentId = agent.thread.added.id;
    const byGrace = applyDeleteComment(
      agent.threads,
      thread.id,
      commentId,
      "Grace",
    );
    expect(byGrace.ok).toBe(true);
    expect(
      applyDeleteComment(agent.threads, thread.id, thread.id, "Grace"),
    ).toEqual({ ok: false, reason: "not_author" });
  });

  test("resolve records who and when, reopen clears it", () => {
    const { thread, threads } = created();
    const resolved = applyUpdateThread(
      threads,
      thread.id,
      { status: "resolved" },
      "Grace",
      5000,
    );
    if (!resolved.ok) throw new Error(resolved.reason);
    expect(resolved.thread.resolvedBy).toBe("Grace");
    expect(resolved.thread.resolvedAt).toBe(5000);
    const reopened = applyUpdateThread(
      resolved.threads,
      thread.id,
      { status: "open" },
      "Ada",
    );
    if (!reopened.ok) throw new Error(reopened.reason);
    expect(reopened.thread.resolvedBy).toBeUndefined();
  });

  test("participants are the author, commenters and assignee, never the agent", () => {
    const { thread, threads } = created([], { assignee: "Linus" });
    const reply = applyAddComment(threads, thread.id, {
      user: "Grace",
      text: "hm",
    });
    if (!reply.ok) throw new Error(reply.reason);
    const agent = applyAddComment(reply.threads, thread.id, {
      user: "Agent",
      text: "answer",
      agent: true,
    });
    if (!agent.ok) throw new Error(agent.reason);
    expect(threadParticipants(agent.thread)).toEqual(["Ada", "Grace", "Linus"]);
    expect(threadParticipants(agent.thread, ["grace"])).toEqual([
      "Ada",
      "Linus",
    ]);
  });

  test("anchors are bounded and must name an entry and a passage", () => {
    expect(cleanAnchor({ entryId: "", exact: "x" })).toBeNull();
    expect(cleanAnchor({ entryId: "e", exact: " " })).toBeNull();
    const long = cleanAnchor({
      entryId: "e",
      exact: "words",
      prefix: "p".repeat(200),
      suffix: "s".repeat(200),
    });
    expect(long?.prefix.length).toBe(64);
    expect(long?.suffix.length).toBe(64);
  });

  test("stored documents drop malformed threads", () => {
    const { thread } = created();
    expect(
      cleanThreads({ threads: [thread, { id: "x" }, null, "nope"] }),
    ).toEqual([thread]);
    expect(cleanThreads(null)).toEqual([]);
  });

  test("legacy notes become open session-level threads with the same id", () => {
    const threads = threadsFromNotes("os-1", [
      { id: "n1", user: "Ada", text: "hello", ts: 10, editedAt: 20 },
      { id: "bad" },
    ]);
    expect(threads).toHaveLength(1);
    expect(threads[0]).toMatchObject({
      id: "n1",
      status: "open",
      createdBy: "Ada",
      ts: 10,
      updatedAt: 20,
    });
    expect(threads[0]!.anchor).toBeUndefined();
    expect(threads[0]!.comments[0]!.id).toBe("n1");
  });
});

describe("comment thread service rules", () => {
  test("@agent asks the agent, an email address does not", () => {
    expect(mentionsAgent("@agent can you check?")).toBe(true);
    expect(mentionsAgent("hey @Agent")).toBe(true);
    expect(mentionsAgent("mail me at x@agent.dev")).toBe(false);
    expect(mentionsAgent("no tag here")).toBe(false);
  });

  test("a plain reply to the agent continues the conversation", () => {
    const { thread, threads } = created();
    const agent = applyAddComment(threads, thread.id, {
      user: "Agent",
      text: "answer",
      agent: true,
    });
    if (!agent.ok) throw new Error(agent.reason);
    const reply = applyAddComment(agent.threads, thread.id, {
      user: "Ada",
      text: "why?",
    });
    if (!reply.ok) throw new Error(reply.reason);
    expect(continuesAgentConversation(reply.thread, reply.thread.added)).toBe(
      true,
    );
    const first = thread.comments[0]!;
    expect(continuesAgentConversation(thread, first)).toBe(false);
  });

  test("thread links open the session with the thread focused", () => {
    expect(threadUrl("os-1", "t 1")).toBe("/session/os-1?thread=t%201");
  });
});

describe("read receipts", () => {
  test("a receipt records the viewer without bumping updatedAt", () => {
    const { threads, thread } = created();
    const seen = applyMarkSeen(threads, thread.id, "Bob", 2000);
    if (!seen.ok) throw new Error(seen.reason);
    expect(seen.changed).toBe(true);
    expect(seen.thread.seenBy).toEqual([{ user: "Bob", ts: 2000 }]);
    expect(seen.thread.updatedAt).toBe(thread.updatedAt);
  });

  test("a second receipt for the same comment writes nothing", () => {
    const { threads, thread } = created();
    const first = applyMarkSeen(threads, thread.id, "Bob", 2000);
    if (!first.ok) throw new Error(first.reason);
    const again = applyMarkSeen(first.threads, thread.id, "bob", 3000);
    if (!again.ok) throw new Error(again.reason);
    expect(again.changed).toBe(false);
    expect(again.thread.seenBy).toEqual([{ user: "Bob", ts: 2000 }]);
  });

  test("a new reply needs a fresh receipt, which replaces the old one", () => {
    const { threads, thread } = created();
    const first = applyMarkSeen(threads, thread.id, "Bob", 2000);
    if (!first.ok) throw new Error(first.reason);
    const reply = applyAddComment(first.threads, thread.id, {
      user: "Ada",
      text: "Ping",
      now: 2500,
    });
    if (!reply.ok) throw new Error(reply.reason);
    const again = applyMarkSeen(reply.threads, thread.id, "Bob", 3000);
    if (!again.ok) throw new Error(again.reason);
    expect(again.changed).toBe(true);
    expect(again.thread.seenBy).toEqual([{ user: "Bob", ts: 3000 }]);
  });

  test("malformed receipts are dropped when the document is read", () => {
    const { thread } = created();
    const [clean] = cleanThreads({
      threads: [
        { ...thread, seenBy: [{ user: "Bob", ts: 1 }, { user: 3 }, "x"] },
      ],
    });
    expect(clean!.seenBy).toEqual([{ user: "Bob", ts: 1 }]);
  });
});
