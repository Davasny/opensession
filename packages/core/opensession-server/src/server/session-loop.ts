/**
 * A session loop: one prompt re-delivered to a session on an interval
 * (`/loop`, or schedule_prompt with every_minutes), optionally until a set
 * time. run-session's loop ticker fires it; this module holds the pure parts
 * so the slash command, the schedule tool and the ticker agree on them.
 */

/** Shortest loop interval: a tick is a whole model turn. */
export const MIN_LOOP_MINUTES = 5;
/** Longest a loop may be told to run in one go: a day. */
export const MAX_LOOP_FOR_MINUTES = 24 * 60;

function durationMinutes(amount: string, unit?: string): number {
  const n = parseInt(amount, 10);
  return unit === "h" || unit === "hr" ? n * 60 : n;
}

/** `<interval> [for <duration>] <prompt>`, e.g. `15m for 2h check CI`. The
 *  interval is raised to MIN_LOOP_MINUTES and the duration capped at a day. */
export function parseLoopCommand(rest: string): {
  intervalMinutes: number;
  forMinutes?: number;
  prompt: string;
} | null {
  const match = rest
    .trim()
    .match(
      /^(\d+)\s*(m|min|h|hr)?(?:\s+for\s+(\d+)\s*(m|min|h|hr)?)?\s+([\s\S]+)$/,
    );
  if (!match) return null;
  const prompt = match[5]!.trim();
  if (!prompt) return null;
  const intervalMinutes = Math.max(
    MIN_LOOP_MINUTES,
    durationMinutes(match[1]!, match[2]),
  );
  if (!match[3]) return { intervalMinutes, prompt };
  const forMinutes = Math.min(
    MAX_LOOP_FOR_MINUTES,
    durationMinutes(match[3], match[4]),
  );
  if (forMinutes <= 0) return null;
  return { intervalMinutes, forMinutes, prompt };
}

/** "every 15m until 14:30 UTC" for status lines and tool results. */
export function describeLoop(loop: {
  intervalMinutes: number;
  until?: string;
}): string {
  const every = `every ${loop.intervalMinutes}m`;
  if (!loop.until) return every;
  const until = new Date(loop.until);
  if (Number.isNaN(until.getTime())) return every;
  return `${every} until ${until.toISOString().slice(11, 16)} UTC`;
}

/** The model-only note riding each tick (protocol loopTickMessage). A tick
 *  arrives in the person's name, so the model needs telling that it is a
 *  loop, that each answer is an update, and how to stop it. */
export function loopTickNote(loop: {
  intervalMinutes: number;
  until?: string;
}): string {
  return (
    `This is a loop check (${describeLoop(loop)}). Give the update as your final answer and end your turn; ` +
    "do not poll inside the turn, the next check comes by itself. Once the goal is met, " +
    "something needs the person, or they say stop, stop the loop with `cancel_scheduled_prompt` id `loop` " +
    "(or send `/loop stop` to this session) and say so."
  );
}

/** Whether a loop has run past its end time. */
export function loopExpired(
  loop: { until?: string },
  now = Date.now(),
): boolean {
  if (!loop.until) return false;
  const until = Date.parse(loop.until);
  return !Number.isNaN(until) && now >= until;
}
