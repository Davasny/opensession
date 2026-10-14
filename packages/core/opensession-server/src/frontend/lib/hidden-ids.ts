// Cards the viewer closed. Hiding is a view choice, not a state of the thing
// the card shows, so it stays in this browser. Entries expire after a week:
// ended cards leave on their own long before that.

const TTL_MS = 7 * 24 * 60 * 60_000;

/** A localStorage set of hidden ids under `key`, each kept for a week. */
export function hiddenIdStore(key: string) {
  /** The stored hides still in force: id → when it was hidden. */
  function read(now: number): Map<string, number> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(localStorage.getItem(key) ?? "{}");
    } catch {
      return new Map();
    }
    if (!parsed || Array.isArray(parsed) || !(parsed instanceof Object))
      return new Map();
    return new Map(
      Object.entries(parsed)
        .map(([id, at]): [string, number] => [id, Number(at)])
        .filter(([, at]) => Number.isFinite(at) && now - at < TTL_MS),
    );
  }
  return {
    ids(now = Date.now()): Set<string> {
      return new Set(read(now).keys());
    },
    hide(id: string, now = Date.now()): void {
      const kept = read(now).set(id, now);
      try {
        localStorage.setItem(key, JSON.stringify(Object.fromEntries(kept)));
      } catch {
        // Storage full or blocked: the card still hides for this page view.
      }
    },
  };
}
