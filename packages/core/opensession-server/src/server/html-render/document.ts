/**
 * What an HTML render's stored page is: the agent's document with a small
 * bootstrap ahead of its first byte, and its local images inlined.
 *
 * The bootstrap does four things, all of them for the page's client:
 * - themes the page before first paint, from the URL fragment the client
 *   adds (`#os-theme=…`) or, without one, from the OS appearance;
 * - re-themes it live on the client's `host-context-changed` message;
 * - reports its content height (`size-changed`) so the client fits the frame
 *   to it, measured the way the server measures it;
 * - turns a click on an outbound link into an `open-link` request, so the
 *   page in the transcript is never replaced by another one.
 *
 * None of this is a security boundary. The page is untrusted and runs with
 * an opaque origin (the frame's sandbox and the asset route's CSP); the
 * bootstrap only makes a well-behaved page fit in.
 */

import { readFile, stat } from "node:fs/promises";
import {
  HTML_HOST_CONTEXT_CHANGED,
  HTML_OPEN_LINK,
  HTML_SIZE_CHANGED,
  HTML_THEME_DEFAULTS,
  HTML_THEME_FRAGMENT_KEY,
  type HtmlTheme,
} from "@tellahq/opensession-protocol/html-render";

/** A page bigger than this, images inlined, is refused. */
export const MAX_PAGE_BYTES = 4 * 1024 * 1024;
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;

// Text matches the reply around the frame: its size and medium weight, and
// no font-smoothing override (that thins every stem on macOS).
// The frame scrolls a page taller than itself, but a scrollbar inside the
// reply reads as a box within the transcript, so it stays hidden.
export const BASE_CSS =
  "html{background:var(--background);color:var(--foreground);font-family:var(--font-sans);font-size:var(--font-size,15px);font-weight:var(--font-weight,450);line-height:1.6;-webkit-text-size-adjust:100%;scrollbar-width:none}" +
  "html::-webkit-scrollbar{display:none}body{margin:0}code,kbd,pre,samp{font-family:var(--font-mono)}a{color:var(--link)}" +
  // Framed, the root is transparent and the transcript's own background
  // shows through (the same colour). An opaque root makes Chrome draw the
  // page's text with subpixel antialiasing, colour fringes and all, beside
  // the reply's greyscale text.
  "html[data-os-framed]{background:transparent}" +
  // Focus rings paint inside the element, so the frame edge never clips them.
  ":where(:focus-visible){outline:2px solid var(--accent);outline-offset:-2px}";

/** The page's height, the same expression in the bootstrap and the server's
 *  headless browser. */
export const MEASURE_EXPRESSION =
  "(function(){var r=document.documentElement;return Math.ceil(r.scrollHeight>r.clientHeight?r.scrollHeight:r.getBoundingClientRect().height)})()";

export function themeRule(theme: HtmlTheme): string {
  const declarations = Object.entries(theme.variables)
    .map(([name, value]) => `${name}:${value};`)
    .join("");
  return `:root{color-scheme:${theme.appearance};${declarations}}`;
}

const BOOTSTRAP_SCRIPT = `(function(){var s=document.getElementById("os-theme"),n=0;if(!s)return;var b=${JSON.stringify(BASE_CSS)};function a(t){if(!t||typeof t!=="object"||!t.variables||typeof t.variables!=="object")return;var c=":root{color-scheme:"+(t.appearance==="light"?"light":"dark")+";";for(var k in t.variables){if(/^--[a-z0-9-]+$/.test(k))c+=k+":"+String(t.variables[k]).replace(/[;{}<>]/g,"")+";";}s.textContent=c+"}"+b;}try{var m=/[#&]${HTML_THEME_FRAGMENT_KEY}=([^&]*)/.exec(location.hash);if(m){a(JSON.parse(decodeURIComponent(m[1])));history.replaceState(history.state,"",location.pathname+location.search);}}catch(e){}var f=window.parent!==window;if(f)document.documentElement.setAttribute("data-os-framed","");window.addEventListener("message",function(e){if(f&&e.source!==window.parent)return;var d=e.data,p=d&&d.params;if(d&&d.jsonrpc==="2.0"&&d.method===${JSON.stringify(HTML_HOST_CONTEXT_CHANGED)}&&p&&p.styles)a({appearance:p.theme,variables:p.styles.variables});});document.addEventListener("click",function(e){var l=e.isTrusted&&e.composedPath?e.composedPath().find(function(t){return t&&t.matches&&t.matches("a[href]");}):null,u;if(!l||e.defaultPrevented)return;try{u=new URL(l.getAttribute("href"),document.baseURI);}catch(x){return;}if(!/^https?:$/.test(u.protocol)||u.href.split("#")[0]===location.href.split("#")[0])return;if(f){e.preventDefault();window.parent.postMessage({jsonrpc:"2.0",id:"os-link-"+(++n),method:${JSON.stringify(HTML_OPEN_LINK)},params:{url:u.href}},"*");}else{l.setAttribute("target","_blank");l.setAttribute("rel","noopener");}},true);if(f){var h,o,z=function(){var v=${MEASURE_EXPRESSION};if(v===h)return;h=v;window.parent.postMessage({jsonrpc:"2.0",method:${JSON.stringify(HTML_SIZE_CHANGED)},params:{height:v}},"*");};if(window.ResizeObserver){o=new ResizeObserver(z);o.observe(document.documentElement);}document.addEventListener("DOMContentLoaded",function(){if(o&&document.body)o.observe(document.body);z();});window.addEventListener("load",z);}})();`;

/** The markup that goes ahead of the page. Without a client-provided theme
 *  (a direct download, the headless preview) the page follows the OS. */
export function bootstrapMarkup(): string {
  const defaultCss =
    themeRule(HTML_THEME_DEFAULTS.dark) +
    `@media (prefers-color-scheme: light){${themeRule(HTML_THEME_DEFAULTS.light)}}` +
    BASE_CSS;
  return (
    '<meta charset="utf-8">' +
    '<meta name="viewport" content="width=device-width, initial-scale=1">' +
    `<style id="os-theme">${defaultCss}</style>` +
    `<script>${BOOTSTRAP_SCRIPT}</script>`
  );
}

// A leading BOM, comments, and doctype stay first: markup ahead of a doctype
// would put the page in quirks mode.
const PROLOGUE_RE = /^﻿?(?:\s|<!--[\s\S]*?-->)*(?:<!doctype[^>]*>)?/i;

/**
 * The page with the bootstrap ahead of its first element. Whatever follows
 * lands after it: the parser opens <html> and <head> for the bootstrap, then
 * folds the page's own <html> attributes into that element and drops a second
 * <head> open tag, so the page's head content follows the bootstrap and its
 * own `:root` rules win.
 */
export function injectBootstrap(html: string): string {
  const prologue = PROLOGUE_RE.exec(html)?.[0] ?? "";
  const doctype = /<!doctype/i.test(prologue) ? "" : "<!doctype html>";
  return prologue + doctype + bootstrapMarkup() + html.slice(prologue.length);
}

const IMAGE_MIME: Record<string, string> = {
  png: "image/png",
  jpg: "image/jpeg",
  jpeg: "image/jpeg",
  gif: "image/gif",
  webp: "image/webp",
  avif: "image/avif",
  svg: "image/svg+xml",
  ico: "image/x-icon",
};
const EXTENSIONS = Object.keys(IMAGE_MIME).join("|");
// An absolute path in quotes (an attribute or a JS string) or in CSS url().
// The path starts with a single slash and a word character, so protocol-
// relative URLs and root-relative paths written as `/x` are not mistaken for
// files unless such a file exists.
const LOCAL_IMAGE_RE = new RegExp(
  String.raw`(["'\x60])(\/[\w.~-][^"'\x60\r\n<>]{0,2048}?\.(?:${EXTENSIONS}))\1` +
    String.raw`|url\(\s*(\/[\w.~-][^\s"'\x60()<>]{0,2048}?\.(?:${EXTENSIONS}))\s*\)`,
  "gi",
);

/**
 * Local images written as absolute paths, inlined as data: URLs: the page's
 * frame has an opaque origin and could not load them from the host anyway.
 * A path that is not a readable file stays as written and is reported.
 */
export async function inlineLocalImages(
  html: string,
): Promise<{ html: string; missing: string[]; tooLarge: string[] }> {
  const paths = new Set<string>();
  for (const m of html.matchAll(LOCAL_IMAGE_RE)) paths.add(m[2] ?? m[3]!);
  const data = new Map<string, string>();
  const missing: string[] = [];
  const tooLarge: string[] = [];
  await Promise.all(
    [...paths].map(async (path) => {
      try {
        const info = await stat(path);
        if (!info.isFile()) return void missing.push(path);
        if (info.size > MAX_IMAGE_BYTES) return void tooLarge.push(path);
        const ext = path.slice(path.lastIndexOf(".") + 1).toLowerCase();
        const bytes = await readFile(path);
        data.set(
          path,
          `data:${IMAGE_MIME[ext]};base64,${bytes.toString("base64")}`,
        );
      } catch {
        missing.push(path);
      }
    }),
  );
  if (data.size === 0) return { html, missing, tooLarge };
  const out = html.replace(
    LOCAL_IMAGE_RE,
    (match, quote: string, quoted: string, inUrl: string) => {
      const path = quoted ?? inUrl;
      const url = data.get(path);
      if (!url) return match;
      return quoted ? `${quote}${url}${quote}` : `url(${url})`;
    },
  );
  return { html: out, missing, tooLarge };
}

/** A readable file name from a title. */
export function renderSlug(title: string): string {
  return (
    title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 48) || "page"
  );
}
