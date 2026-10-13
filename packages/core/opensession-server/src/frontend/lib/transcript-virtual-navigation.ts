export interface TranscriptVirtualNavigation {
  scrollToEntry(entryId: string): boolean;
  /** The key of the row an entry renders in, even when the entry itself draws
   * nothing yet (folded inside a turn). */
  rowKeyForEntry?(entryId: string): string | undefined;
}

const virtualNavigation = new WeakMap<
  HTMLElement,
  TranscriptVirtualNavigation
>();

/** Register the virtual transcript living inside one scroll container. */
export function registerTranscriptVirtualNavigation(
  container: HTMLElement,
  navigation: TranscriptVirtualNavigation,
): () => void {
  virtualNavigation.set(container, navigation);
  return () => {
    if (virtualNavigation.get(container) === navigation)
      virtualNavigation.delete(container);
  };
}

/** Ask a virtual transcript to mount and reveal an entry. */
export function scrollToVirtualTranscriptEntry(
  container: HTMLElement,
  entryId: string,
): boolean {
  return virtualNavigation.get(container)?.scrollToEntry(entryId) ?? false;
}

/** The mounted virtual row holding an entry, or null when it is not mounted
 * (or the transcript is not virtual). */
export function virtualTranscriptRowFor(
  container: HTMLElement,
  entryId: string,
): HTMLElement | null {
  const key = virtualNavigation.get(container)?.rowKeyForEntry?.(entryId);
  if (key === undefined) return null;
  return container.querySelector<HTMLElement>(
    `[data-transcript-key="${CSS.escape(key)}"]`,
  );
}
