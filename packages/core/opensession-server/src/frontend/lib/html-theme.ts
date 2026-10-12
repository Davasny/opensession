/**
 * The app's theme as the CSS custom properties a page in a frame styles
 * against: ```artifact fences (written into the document) and HTML renders
 * (handed over in the URL fragment, then by message). The names and the
 * tokens they read are the protocol's HTML_THEME_TOKENS, so the agent-facing
 * guide, the server's defaults and the live values agree.
 */

import {
  HTML_THEME_DEFAULTS,
  HTML_THEME_TOKENS,
  type HtmlTheme,
} from "@tellahq/opensession-protocol/html-render";

export function readHtmlTheme(): HtmlTheme {
  const root = document.documentElement;
  const style = getComputedStyle(root);
  const appearance = root.dataset.theme === "light" ? "light" : "dark";
  const defaults = HTML_THEME_DEFAULTS[appearance].variables;
  const variables: Record<string, string> = {};
  for (const [name, token] of Object.entries(HTML_THEME_TOKENS))
    variables[name] = style.getPropertyValue(token).trim() || defaults[name]!;
  // The app's block corner, at the user's roundness setting.
  const rf = Number.parseFloat(style.getPropertyValue("--rf"));
  variables["--radius"] = Number.isFinite(rf)
    ? `${Math.round(8 * rf * 10) / 10}px`
    : defaults["--radius"]!;
  return { appearance, variables };
}
