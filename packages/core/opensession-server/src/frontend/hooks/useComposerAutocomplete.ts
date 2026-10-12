import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type RefObject,
} from "react";
import {
  ghostSuffix,
  wantsCompletion,
  type ComposerSuggestion,
} from "../lib/composer-prediction";
import {
  getComposerAutocompletePref,
  onComposerAutocompleteChanged,
} from "../lib/composer-prediction-pref";
import { composerAutocompleteAvailable } from "../lib/api/composer-autocomplete";

/** How long the draft has to sit still before a suggestion is asked for. */
const PAUSE_MS = 300;

export type ComposerComplete = (
  draft: string,
  signal: AbortSignal,
) => Promise<string | null>;

function caretAtEnd(el: HTMLTextAreaElement | null): boolean {
  return (
    !!el &&
    el.selectionStart === el.selectionEnd &&
    el.selectionEnd === el.value.length
  );
}

/**
 * Typing autocomplete for the composer (server/composer-autocomplete.ts).
 *
 * After a pause with the caret at the end of the draft, asks `complete` for
 * the rest of the message. Every draft change cancels the timer and the
 * request in flight, so at most one call is outstanding and none outlives the
 * text it was asked about. A suggestion survives typing through it
 * (`ghostSuffix`); Escape dismisses it until the draft changes.
 */
export function useComposerAutocomplete({
  complete,
  text,
  enabled,
  textareaRef,
}: {
  complete: ComposerComplete | undefined;
  text: string;
  enabled: boolean;
  textareaRef: RefObject<HTMLTextAreaElement | null>;
}) {
  const [suggestion, setSuggestionState] = useState<ComposerSuggestion | null>(
    null,
  );
  // Read by the request effect without making a new answer re-trigger it.
  const suggestionRef = useRef<ComposerSuggestion | null>(null);
  const setSuggestion = (next: ComposerSuggestion | null) => {
    suggestionRef.current = next;
    setSuggestionState(next);
  };
  const [atEnd, setAtEnd] = useState(true);
  const dismissedFor = useRef<string | null>(null);
  const live = !!complete && enabled;
  // Callers pass a fresh closure on every render; only the latest is called,
  // and a new identity alone must not restart the pause timer.
  const completeRef = useRef(complete);
  useLayoutEffect(() => {
    completeRef.current = complete;
  }, [complete]);
  const ghost = live && atEnd ? ghostSuffix(text, suggestion) : null;

  useEffect(() => {
    if (!live) return;
    if (!wantsCompletion(text) || dismissedFor.current === text) return;
    // Still typing through the last suggestion: nothing new to ask.
    if (ghostSuffix(text, suggestionRef.current)) return;
    const controller = new AbortController();
    const timer = setTimeout(() => {
      const ask = completeRef.current;
      if (!ask || !caretAtEnd(textareaRef.current)) return;
      ask(text, controller.signal)
        .then((completion) => {
          if (controller.signal.aborted || !completion) return;
          const next = { base: text, completion };
          suggestionRef.current = next;
          setSuggestionState(next);
        })
        .catch(() => {});
    }, PAUSE_MS);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [text, live, textareaRef]);

  return {
    ghost,
    /** Escape: hide the suggestion and ask nothing more for this draft. */
    dismiss() {
      dismissedFor.current = text;
      setSuggestion(null);
    },
    /** The suggestion was taken into the draft. */
    taken() {
      setSuggestion(null);
    },
    /** Selection changes: a suggestion only makes sense at the caret. */
    onSelect() {
      setAtEnd(caretAtEnd(textareaRef.current));
    },
  };
}

/**
 * The person turned autocomplete on (it is off by default) and this instance
 * can serve it (an OpenAI key is configured and the kill switch is off).
 */
export function useComposerAutocompleteEnabled(): boolean {
  const [on, setOn] = useState(getComposerAutocompletePref);
  const [available, setAvailable] = useState(false);
  useEffect(
    () =>
      onComposerAutocompleteChanged(() => setOn(getComposerAutocompletePref())),
    [],
  );
  useEffect(() => {
    if (!on) return;
    let live = true;
    void composerAutocompleteAvailable().then((ok) => {
      if (live) setAvailable(ok);
    });
    return () => {
      live = false;
    };
  }, [on]);
  return on && available;
}
