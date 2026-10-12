// Predicted next message for the empty composer (server/composer-prediction.ts).
// It arrives over the session socket as `composer_prediction`, shows as the
// composer's placeholder, and Tab in the empty composer takes it as a draft.
// Autocomplete (server/composer-autocomplete.ts) is the same idea while
// typing: faint text after the caret that Tab takes. On touch, a double tap
// does what Tab does. The switches live in lib/composer-prediction-pref.ts.

/**
 * Tab takes the prediction only from an empty composer, and only as a bare
 * Tab: Shift+Tab and modified Tabs keep their focus-moving meaning.
 */
export function takesPrediction(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
  draft: string,
  prediction: string | null | undefined,
): prediction is string {
  return !!prediction && isBareTab(e) && draft.trim() === "";
}

/** A completion fetched for the draft as it was (`base`). */
export interface ComposerSuggestion {
  base: string;
  completion: string;
}

/**
 * The part of a suggestion still ahead of the caret, or null. Typing the
 * suggested characters keeps it (and shortens it); typing anything else, or
 * deleting back into what was typed when it was asked for, retires it.
 */
export function ghostSuffix(
  draft: string,
  suggestion: ComposerSuggestion | null,
): string | null {
  if (!suggestion) return null;
  const full = suggestion.base + suggestion.completion;
  if (!draft.startsWith(suggestion.base)) return null;
  if (!full.startsWith(draft) || draft.length >= full.length) return null;
  return full.slice(draft.length);
}

/**
 * Worth asking for a completion: the draft has something to finish. A draft
 * that already ends a sentence gets nothing, since the model can only add a
 * sentence of its own (server/composer-autocomplete.ts checks this too).
 */
export function wantsCompletion(draft: string): boolean {
  return draft.trim().length >= 2 && !/[.?!\u2026]["')\]]*\s*$/.test(draft);
}

/** A bare Tab: Shift+Tab and modified Tabs keep their own meaning. */
export function isBareTab(
  e: Pick<KeyboardEvent, "key" | "shiftKey" | "metaKey" | "ctrlKey" | "altKey">,
): boolean {
  return (
    e.key === "Tab" && !e.shiftKey && !e.metaKey && !e.ctrlKey && !e.altKey
  );
}

export interface TapPoint {
  t: number;
  x: number;
  y: number;
}

/** Touch has no Tab key, so a double tap takes a suggestion instead. */
export const DOUBLE_TAP_MS = 350;
export function isDoubleTap(prev: TapPoint | null, next: TapPoint): boolean {
  return (
    !!prev &&
    next.t - prev.t <= DOUBLE_TAP_MS &&
    Math.hypot(next.x - prev.x, next.y - prev.y) <= 40
  );
}
