/**
 * A snapshot file that many callers ask to rewrite, written asynchronously.
 *
 * `schedule()` never touches the filesystem on the caller's stack: it starts
 * one async atomic write (after `delayMs`, when given), and any number of
 * schedules while that write runs produce exactly one more write of the
 * newest state. `render` runs when the write starts, so the file always ends
 * on the latest state. Replaces synchronous snapshot writes on the gateway
 * thread, which stalled every request behind a slow disk.
 */
import { writeFileAtomicAsync } from "./atomic-write";

export interface CoalescedWriter {
  /** Ask for the current state to reach disk soon. Never throws. */
  schedule(): void;
  /** Resolves once everything scheduled so far is written. */
  flush(): Promise<void>;
}

export function coalescedWriter(opts: {
  path: () => string;
  /** The file's content now; called once per write. */
  render: () => string;
  mode?: number;
  /** Wait this long after the first schedule, to batch a burst. */
  delayMs?: number;
  label: string;
}): CoalescedWriter {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let running: Promise<void> | undefined;
  let again = false;

  const write = async () => {
    do {
      again = false;
      try {
        await writeFileAtomicAsync(opts.path(), opts.render(), opts.mode);
      } catch (error) {
        console.error(`[${opts.label}] snapshot write failed:`, error);
      }
    } while (again);
  };

  const start = () => {
    timer = undefined;
    if (running) {
      again = true;
      return;
    }
    running = write().finally(() => {
      running = undefined;
    });
  };

  return {
    schedule() {
      if (running) {
        again = true;
        return;
      }
      if (timer) return;
      if (!opts.delayMs) {
        start();
        return;
      }
      timer = setTimeout(start, opts.delayMs);
      timer.unref?.();
    },
    async flush() {
      if (timer) {
        clearTimeout(timer);
        start();
      }
      while (running) await running;
    },
  };
}
