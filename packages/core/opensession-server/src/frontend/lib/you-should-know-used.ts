import { z } from "zod";

/**
 * Which You should know notes this device has already acted on, so a used
 * note stays folded after a reload. The server remembers the topic itself
 * (later checks skip it); this only remembers how the card looked.
 */
export type YouShouldKnowUse = "asked" | "known";

const KEY = "opensession-you-should-know-used";

// Notes accumulate across sessions. Entries keep insertion order, so trimming
// from the front evicts the oldest.
const MAX_ENTRIES = 500;

const useSchema = z.enum(["asked", "known"]);

function read(
  storage: Pick<Storage, "getItem">,
): Map<string, YouShouldKnowUse> {
  const out = new Map<string, YouShouldKnowUse>();
  try {
    const parsed = z
      .record(z.string(), z.unknown())
      .safeParse(JSON.parse(storage.getItem(KEY) || "{}"));
    if (!parsed.success) return out;
    for (const [key, value] of Object.entries(parsed.data)) {
      const use = useSchema.safeParse(value);
      if (use.success) out.set(key, use.data);
    }
  } catch {
    // Unreadable storage counts as nothing used.
  }
  return out;
}

export function youShouldKnowUseKey(
  sessionId: string | undefined,
  entryId: string,
): string {
  return `${sessionId ?? ""}:${entryId}`;
}

export function getYouShouldKnowUse(
  key: string,
  storage: Pick<Storage, "getItem"> = localStorage,
): YouShouldKnowUse | undefined {
  return read(storage).get(key);
}

export function saveYouShouldKnowUse(
  key: string,
  use: YouShouldKnowUse | undefined,
  storage: Pick<Storage, "getItem" | "setItem"> = localStorage,
): void {
  const map = read(storage);
  map.delete(key);
  if (use) map.set(key, use);
  const keys = [...map.keys()];
  for (const stale of keys.slice(0, Math.max(0, keys.length - MAX_ENTRIES)))
    map.delete(stale);
  try {
    storage.setItem(KEY, JSON.stringify(Object.fromEntries(map)));
  } catch {
    // Storage full or unavailable: the card just won't stay folded.
  }
}
