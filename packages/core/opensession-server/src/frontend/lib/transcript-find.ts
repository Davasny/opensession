import { classifyEntry } from "@tellahq/opensession-protocol/notices";
import { isLegacyReasoningHeading } from "./reasoning-display";
import type { TranscriptEntry } from "./types";

/**
 * Find in session: the matching half, kept pure so it can be tested without a
 * DOM.
 *
 * The browser's own find cannot do this job. The transcript is virtualized, so
 * everything more than a screen or two away from the reader is not in the
 * document at all, and the Mac app's shell has no find bar to begin with. So
 * matches are counted from the loaded transcript entries, and only the one
 * being shown is located in the DOM (see `textRanges`).
 *
 * What is searched is what a person reads as the conversation: their own
 * messages and the agent's prose. Tool calls, their output and provider
 * reasoning stay out: they are folded by default, and a match in a 4,000 line
 * build log is noise when you are looking for something someone said.
 */

/** Opens the find bar from the command menu, which has no key event to hand
 *  over. */
export const TRANSCRIPT_FIND_EVENT = "opensession:transcript-find";

/** One occurrence: the `occurrence`th match inside entry `entryId`. */
export interface FindMatch {
  entryId: string;
  occurrence: number;
}

/** Past this the counter reads "1000+" rather than walking every log. */
export const MAX_FIND_MATCHES = 1000;

/** Undo the markdown a reader never sees, so a search for a word that was
 *  written in bold or as a link still lands. Code keeps its text. */
function readableText(markdown: string): string {
  return markdown
    .replace(/^\s{0,3}(```|~~~).*$/gm, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__|~~)(.+?)\1/g, "$2")
    .replace(/\s+/g, " ");
}

/** The text an entry contributes to find, or null when it is not searched. */
export function findableText(entry: TranscriptEntry): string | null {
  if (entry.type === "assistant") {
    if (entry.isReasoning || isLegacyReasoningHeading(entry.content))
      return null;
    return entry.content ? readableText(entry.content) : null;
  }
  if (entry.type !== "user") return null;
  // Classification strips the "[Name] " delivery prefix and turns
  // operational deliveries into notices, mirroring what MessageBubble draws.
  const classified = classifyEntry(entry);
  if (classified.notice || !classified.content) return null;
  return readableText(classified.content);
}

/** Case-insensitive needle, or null for a query that should match nothing. */
export function normalizeFindQuery(query: string): string | null {
  const needle = query.replace(/\s+/g, " ").toLowerCase();
  return needle.trim() ? needle : null;
}

function countOccurrences(haystack: string, needle: string, limit: number) {
  let count = 0;
  let at = haystack.indexOf(needle);
  while (at !== -1 && count < limit) {
    count++;
    at = haystack.indexOf(needle, at + needle.length);
  }
  return count;
}

/** Every occurrence of `query` in the searchable entries, oldest first. */
export function findTranscriptMatches(
  entries: readonly TranscriptEntry[],
  query: string,
  limit = MAX_FIND_MATCHES,
): FindMatch[] {
  const needle = normalizeFindQuery(query);
  if (!needle) return [];
  const matches: FindMatch[] = [];
  for (const entry of entries) {
    const text = findableText(entry);
    if (!text) continue;
    const count = countOccurrences(
      text.toLowerCase(),
      needle,
      limit - matches.length,
    );
    for (let occurrence = 0; occurrence < count; occurrence++)
      matches.push({ entryId: entry.id, occurrence });
    if (matches.length >= limit) break;
  }
  return matches;
}

/** Step through matches, wrapping at either end. */
export function stepFindIndex(
  index: number,
  count: number,
  direction: 1 | -1,
): number {
  if (count === 0) return 0;
  return (((index + direction) % count) + count) % count;
}

/**
 * The innermost element drawn for an entry. Several layers can carry the same
 * `data-eid` (the virtual row, a turn anchored on its last item, the bubble
 * itself), and descendants follow their ancestors in document order, so the
 * last one is the entry's own.
 */
export function entryElement(
  container: ParentNode,
  entryId: string,
): HTMLElement | null {
  const nodes = container.querySelectorAll<HTMLElement>(
    `[data-eid="${CSS.escape(entryId)}"]`,
  );
  return nodes[nodes.length - 1] ?? null;
}

/** Text that is on the page but not part of what was said. */
const SKIPPED_TEXT = "script,style,button,[aria-hidden='true']";

/**
 * Every occurrence of `query` in the rendered text under `root`, as DOM
 * ranges. Text nodes are joined first, so a match that crosses inline markup
 * (`foo <code>bar</code>`) is still one range.
 */
export function textRanges(root: Node, query: string): Range[] {
  const needle = normalizeFindQuery(query);
  const doc = root.ownerDocument;
  if (!needle || !doc) return [];
  const walker = doc.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node) =>
      node.parentElement?.closest(SKIPPED_TEXT)
        ? NodeFilter.FILTER_REJECT
        : NodeFilter.FILTER_ACCEPT,
  });
  const nodes: Text[] = [];
  const starts: number[] = [];
  let text = "";
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    if (!(node instanceof Text)) continue;
    nodes.push(node);
    starts.push(text.length);
    // Same normalization as the query, one character for one, so offsets
    // still map back onto the node.
    const data = node.data.replace(/\s/g, " ");
    const lower = data.toLowerCase();
    text += lower.length === data.length ? lower : data;
  }
  if (nodes.length === 0) return [];
  const locate = (offset: number, end: boolean): [Text, number] => {
    // The last node starting at or before `offset` (strictly before for an
    // end offset, so a match ending on a node boundary stays in that node).
    let lo = 0;
    let hi = nodes.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (end ? starts[mid] < offset : starts[mid] <= offset) lo = mid;
      else hi = mid - 1;
    }
    return [nodes[lo], offset - starts[lo]];
  };
  const ranges: Range[] = [];
  // Whitespace runs collapse in the query; match them against any run here.
  const pattern = new RegExp(
    needle
      .split(" ")
      .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
      .join(" +"),
    "g",
  );
  for (const match of text.matchAll(pattern)) {
    if (match[0].length === 0) break;
    const begin = match.index ?? 0;
    const [startNode, startOffset] = locate(begin, false);
    const [endNode, endOffset] = locate(begin + match[0].length, true);
    const range = doc.createRange();
    range.setStart(startNode, startOffset);
    range.setEnd(endNode, endOffset);
    ranges.push(range);
    if (ranges.length >= MAX_FIND_MATCHES) break;
  }
  return ranges;
}
