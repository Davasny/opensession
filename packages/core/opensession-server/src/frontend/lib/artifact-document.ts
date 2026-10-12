/**
 * The pure half of an ```artifact / ```svg block: what goes into the
 * sandboxed frame's `srcdoc`, and the sandbox and policy that keep it there.
 *
 * An artifact is untrusted by definition: it is whatever the agent wrote,
 * and the frame exists so it can be anything without touching the page.
 * Three layers hold that line, and every one of them is decided here so a
 * test can read the strings:
 *
 * - `sandbox=""` (ARTIFACT_SANDBOX): every restriction the browser has. No
 *   scripts, so nothing in the frame acts on its own; an opaque origin, so
 *   there is no reach into the app's DOM, storage or cookies; no forms, no
 *   popups, no navigating the page; and, since scripts are off, no
 *   automatic features either, which is what keeps a `<meta refresh>` from
 *   steering the frame elsewhere. Scripts are never on: a frame that may
 *   run script may also navigate itself, `location.href = …` is an
 *   outbound request no policy the browser enforces today can stop, and a
 *   frame that can do that is not the frame this block promises.
 * - A `<meta http-equiv="Content-Security-Policy">` (artifactCsp) with
 *   `default-src 'none'`, so nothing inside the frame fetches or loads from
 *   anywhere; inline styles and `data:` images and fonts are the whole
 *   allowance.
 * - The policy is written into a head the block itself opens, ahead of the
 *   first byte of the artifact (artifactHtmlDocument). Nothing in the
 *   source can get in front of it, and a policy in force is only ever
 *   tightened by what follows, so a document with its own `<head>`, a
 *   comment that looks like one, or no head at all is held the same way.
 *   The same head aims every link at a new window (`<base target>`), which
 *   the sandbox refuses: a click inside the frame goes nowhere, rather than
 *   loading a foreign page into it.
 *
 * The block sizes its frame to the document by laying the same `srcdoc`
 * out once in a hidden probe frame (artifact-frame.ts), whose sandbox is
 * `allow-same-origin` alone (ARTIFACT_PROBE_SANDBOX) so the block can read
 * its height. That probe is as inert as the visible frame: the same policy
 * leads its head, no script runs in it (the sandbox has no `allow-scripts`
 * and the policy has no script source), nothing loads, no form submits, no
 * automatic feature fires, it sits off screen where nothing can click it,
 * and it is removed once measured. Same-origin only lets the block read in;
 * nothing in the probe can act to read out.
 *
 * A fragment is wrapped in a minimal document that takes the app's theme as
 * CSS custom properties (the same names an HTML render gets, see
 * HTML_THEME_TOKENS), so a snippet reads as native in both themes and an
 * author can style against --card, --border, --chart-1 and the rest.
 * A complete document simply follows the block's head: the parser folds a
 * second `<html>` into the first (its attributes kept) and drops a second
 * `<head>` open tag, so the author's own head content lands after the base
 * style and wins. An SVG becomes an `<img src="data:image/svg+xml,…">`
 * inside the same frame: an image never runs script, never loads anything
 * external, and sizes itself.
 */

import { readDiagramSvg } from "./diagram-media";

export interface ArtifactTheme {
  scheme: "light" | "dark";
  /** Page variables (--background, --foreground, --card, ...), resolved
   *  from the app's tokens; see HTML_THEME_TOKENS. */
  variables: Record<string, string>;
}

/** The frame's default height, and the range a drag is clamped to. In CSS
 *  pixels. */
export const ARTIFACT_DEFAULT_HEIGHT = 320;
export const ARTIFACT_MIN_HEIGHT = 48;
export const ARTIFACT_MAX_HEIGHT = 2000;

/** The frame's `sandbox` attribute. Empty is the fully locked sandbox: no
 *  token is ever added, see the header. */
export const ARTIFACT_SANDBOX = "";

/** The hidden probe frame's sandbox: same-origin so the block can read the
 *  laid-out height, and nothing else. See the header for why that stays
 *  inert. */
export const ARTIFACT_PROBE_SANDBOX = "allow-same-origin";

/** The policy written into the document head. `default-src 'none'` is the
 *  whole point; the rest re-opens exactly what an inline document needs. */
export function artifactCsp(): string {
  return [
    "default-src 'none'",
    "img-src data:",
    "style-src 'unsafe-inline'",
    "font-src data:",
    "form-action 'none'",
    "base-uri 'none'",
  ].join("; ");
}

export function clampArtifactHeight(height: number): number {
  if (!Number.isFinite(height)) return ARTIFACT_DEFAULT_HEIGHT;
  return Math.min(
    ARTIFACT_MAX_HEIGHT,
    Math.max(ARTIFACT_MIN_HEIGHT, Math.round(height)),
  );
}

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** A CSS value is written into the document's <style>; strip anything that
 *  could close the declaration, the rule or the element. */
function cssValue(s: string): string {
  return s.replace(/[<>{};]/g, "").trim();
}

/**
 * The app's theme as the document's base style. First in the head, so
 * anything the author wrote after it wins; a document that never mentions
 * its background still reads as part of the reply. No body margin: the
 * frame is borderless and lines up with the reply text.
 */
function baseStyle(theme: ArtifactTheme): string {
  const variables = Object.entries(theme.variables)
    .filter(([name]) => /^--[a-z0-9-]+$/.test(name))
    .map(([name, value]) => `${name}:${cssValue(value)};`)
    .join("");
  return (
    "<style>" +
    `:root{color-scheme:${theme.scheme === "light" ? "light" : "dark"};${variables}` +
    "background:var(--background);color:var(--foreground);" +
    "font-family:var(--font-sans);font-size:var(--font-size,15px);font-weight:var(--font-weight,450);line-height:1.6}" +
    "body{margin:0}" +
    "a{color:var(--link)}" +
    "code,kbd,pre,samp{font-family:var(--font-mono)}" +
    "img,svg,video,canvas{max-width:100%}" +
    "</style>"
  );
}

/**
 * The opening of every artifact document, before any of the source: the
 * charset, the policy, the link target and the base style. A complete
 * document's own head content follows it inside the same `<head>`.
 */
export function artifactDocumentHead(theme: ArtifactTheme): string {
  return (
    '<!doctype html><html><head><meta charset="utf-8">' +
    `<meta http-equiv="Content-Security-Policy" content="${artifactCsp()}">` +
    '<base target="_blank">' +
    baseStyle(theme)
  );
}

/** Whether the source is already a complete document rather than a fragment. */
export function isCompleteHtmlDocument(source: string): boolean {
  return /^\s*(<!doctype\b|<html\b)/i.test(source);
}

/**
 * The `srcdoc` for an HTML artifact. A fragment gets a whole document
 * around it; a complete one follows the block's head as written, where the
 * parser ignores its doctype and second `<head>` and folds its `<html>`
 * into the one already open. Both work while the fence is still streaming:
 * HTML tolerates a document that stops mid-tag.
 */
export function artifactHtmlDocument(
  source: string,
  theme: ArtifactTheme,
): string {
  const head = artifactDocumentHead(theme);
  if (isCompleteHtmlDocument(source)) return head + source;
  return `${head}</head><body>${source}</body></html>`;
}

/** Strip an XML prolog, doctype and leading comments so the root <svg> is
 *  the first tag, which is what the size reader expects. */
function svgRoot(source: string): string {
  return source.replace(
    /^\s*(?:<\?xml[^>]*\?>|<!DOCTYPE[^>]*>|<!--[\s\S]*?-->)\s*/gi,
    "",
  );
}

/** The SVG's own size, when it declares one, so the frame can be sized to
 *  its aspect ratio before anything loads: a frame cannot report. */
export function svgArtifactSize(
  source: string,
): { w: number; h: number } | null {
  return readDiagramSvg(svgRoot(source))?.size ?? null;
}

/**
 * The `srcdoc` for an SVG artifact: the drawing as an image on the app's
 * background, at the frame's width.
 */
export function artifactSvgDocument(
  source: string,
  theme: ArtifactTheme,
): string {
  const dataUrl = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svgRoot(source))}`;
  return (
    artifactDocumentHead(theme) +
    "<style>body{margin:0}img{display:block;width:100%;height:auto}</style>" +
    `</head><body><img src="${escapeHtml(dataUrl)}" alt=""></body></html>`
  );
}
