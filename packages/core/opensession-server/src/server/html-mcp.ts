/**
 * `opensession-html`: pages an agent shows inline in a session.
 *
 * - `html_preview` loads a page in a headless Chrome and returns what the
 *   agent cannot see on its own: a screenshot, the console (errors with line
 *   numbers), and the height the page needs at a width. It previews either a
 *   page for `html_render` or an ```artifact fence, which runs no script.
 * - `html_render` stores a finished page as a session asset, with the theme
 *   and sizing bootstrap in its head (html-render/document.ts), measures it at
 *   phone-to-desktop widths, and answers with a reference every client shows
 *   inline under the turn: a frame that runs the page's script with an opaque
 *   origin, sized to the page, in the reader's theme.
 *
 * Interactive-only: the browser is open-world (a page may load a CDN
 * library), so untrusted automation input does not get to drive it. Its
 * traffic only reaches public addresses (html-render/public-proxy.ts).
 */

import {
  HTML_LAYOUT_GUIDE,
  HTML_PREVIEW_TOOL,
  HTML_RENDER_ASSET_DIR,
  HTML_RENDER_COLUMN_WIDTH,
  HTML_RENDER_MAX_HEIGHT,
  HTML_RENDER_MAX_TITLE_LENGTH,
  HTML_RENDER_MEASURE_WIDTHS,
  HTML_RENDER_MIN_HEIGHT,
  HTML_RENDER_RESULT_MAX_BYTES,
  HTML_RENDER_SERVER,
  HTML_RENDER_TOOL,
  HTML_THEME_DEFAULTS,
  HTML_THEME_GUIDE,
  clampHtmlRenderHeight,
  type HtmlRenderReference,
} from "@tellahq/opensession-protocol/html-render";
import { z } from "zod";
import { artifactHtmlDocument } from "../frontend/lib/artifact-document";
import {
  MAX_PAGE_BYTES,
  injectBootstrap,
  inlineLocalImages,
  renderSlug,
} from "./html-render/document";
import {
  BrowserUnavailableError,
  withHeadlessPage,
  type ConsoleMessage,
} from "./html-render/headless";
import { createSdkMcpServer, tool } from "./inprocess-mcp";
import { writeAsset } from "./session-assets";

export const MAX_HTML_BYTES = 512 * 1024;

const PAGE_RULES =
  'Write one self-contained document with inline <style> and <script>. Local images written as absolute file paths (src="/abs/shot.png", CSS url(/abs/bg.webp), or a JS string) are inlined automatically; remote https URLs, such as a CDN chart library, load as-is. The page runs with an opaque origin: no cookies, localStorage or Open Session API, and only public network addresses.';

type Appearance = "light" | "dark";

function text(s: string) {
  return { content: [{ type: "text" as const, text: s }] };
}

function failure(s: string) {
  return { ...text(s), isError: true };
}

/** The browser's own noise about the fake page origin, not the page's. */
function pageConsole(messages: ConsoleMessage[]): ConsoleMessage[] {
  return messages.filter(
    (m) => !m.text.includes("page.opensession.invalid/favicon.ico"),
  );
}

function sizeError(html: string): string | undefined {
  const bytes = Buffer.byteLength(html);
  return bytes > MAX_HTML_BYTES
    ? `The page is ${Math.round(bytes / 1024)} KB; the limit is ${MAX_HTML_BYTES / 1024} KB. Load big libraries from a CDN and inline less data.`
    : undefined;
}

async function preparePage(
  html: string,
): Promise<{ page: string } | { error: string }> {
  const tooBig = sizeError(html);
  if (tooBig) return { error: tooBig };
  const inlined = await inlineLocalImages(html);
  if (inlined.missing.length)
    return {
      error: `These image paths are not readable files on this host: ${inlined.missing.join(", ")}. Use absolute paths to existing files, data: URLs, or https URLs.`,
    };
  if (inlined.tooLarge.length)
    return {
      error: `These images are over 2 MB: ${inlined.tooLarge.join(", ")}. Resize them first.`,
    };
  const page = injectBootstrap(inlined.html);
  if (Buffer.byteLength(page) > MAX_PAGE_BYTES)
    return {
      error: `With its images inlined the page is over ${MAX_PAGE_BYTES / 1024 / 1024} MB. Use smaller images.`,
    };
  return { page };
}

export interface HtmlToolsDeps {
  writeAsset: typeof writeAsset;
  browser: typeof withHeadlessPage;
  now: () => number;
}

const defaultDeps: HtmlToolsDeps = {
  writeAsset,
  browser: withHeadlessPage,
  now: Date.now,
};

export async function previewHtml(
  input: {
    html: string;
    width?: number;
    appearance?: Appearance;
    mode?: "render" | "artifact";
  },
  deps: Pick<HtmlToolsDeps, "browser"> = defaultDeps,
) {
  const width = Math.min(
    1600,
    Math.max(240, Math.round(input.width ?? HTML_RENDER_COLUMN_WIDTH)),
  );
  const appearance = input.appearance ?? "dark";
  let page: string;
  if (input.mode === "artifact") {
    const tooBig = sizeError(input.html);
    if (tooBig) return { error: tooBig } as const;
    const theme = HTML_THEME_DEFAULTS[appearance];
    page = artifactHtmlDocument(input.html, {
      scheme: appearance,
      variables: theme.variables,
    });
  } else {
    const prepared = await preparePage(input.html);
    if ("error" in prepared) return prepared;
    page = prepared.page;
  }
  return deps.browser({ width, appearance }, async (browserPage) => {
    const contentHeight = await browserPage.load(page);
    const capturedHeight = Math.min(
      HTML_RENDER_MAX_HEIGHT,
      Math.max(HTML_RENDER_MIN_HEIGHT, contentHeight),
    );
    const screenshot = await browserPage.screenshot(width, capturedHeight);
    return {
      width,
      contentHeight,
      capturedHeight,
      consoleMessages: pageConsole(browserPage.consoleMessages),
      notes: browserPage.notes,
      screenshot,
    } as const;
  });
}

export async function renderHtml(
  input: { sessionId: string; html: string; title: string; height: number },
  deps: HtmlToolsDeps = defaultDeps,
): Promise<
  | { error: string }
  | {
      htmlRender: HtmlRenderReference;
      consoleMessages: ConsoleMessage[];
      notes: string[];
    }
> {
  const title = input.title.trim().slice(0, HTML_RENDER_MAX_TITLE_LENGTH);
  if (!title) return { error: "Give the page a short title." };
  const prepared = await preparePage(input.html);
  if ("error" in prepared) return prepared;
  const notes: string[] = [];
  let heights: Array<[number, number]> | undefined;
  let consoleMessages: ConsoleMessage[] = [];
  try {
    await deps.browser(
      { width: HTML_RENDER_MEASURE_WIDTHS[0], appearance: "dark" },
      async (page) => {
        const measured: Array<[number, number]> = [
          [HTML_RENDER_MEASURE_WIDTHS[0], await page.load(prepared.page)],
        ];
        for (const width of HTML_RENDER_MEASURE_WIDTHS.slice(1))
          measured.push([width, await page.measureAt(width)]);
        heights = measured.map(([w, h]) => [w, clampHtmlRenderHeight(h)]);
        consoleMessages = pageConsole(page.consoleMessages);
        notes.push(...page.notes);
      },
    );
  } catch (error) {
    // Measuring is an improvement, not a requirement: without it the
    // client sizes the frame from the page's own report.
    notes.push(
      error instanceof BrowserUnavailableError
        ? `${error.message} The page was not measured; it sizes itself once it loads.`
        : `Measuring the page failed (${(error as Error).message}); it sizes itself once it loads.`,
    );
  }
  const stamp = deps.now().toString(36);
  const path = `${HTML_RENDER_ASSET_DIR}/${renderSlug(title)}-${stamp}.html`;
  await deps.writeAsset(
    input.sessionId,
    path,
    Buffer.from(prepared.page),
    `HTML render: ${title}`,
  );
  const url = `/api/sessions/${encodeURIComponent(input.sessionId)}/assets/raw/${path
    .split("/")
    .map(encodeURIComponent)
    .join("/")}`;
  return {
    htmlRender: {
      url,
      path,
      title,
      height: clampHtmlRenderHeight(input.height),
      ...(heights ? { heights } : {}),
    },
    consoleMessages,
    notes,
  };
}

function consoleSummary(messages: ConsoleMessage[]): string {
  return messages.map((m) => `[${m.level}] ${m.text}`).join("\n");
}

export function createHtmlMcpServer(
  ctx: { sessionId: string },
  deps: HtmlToolsDeps = defaultDeps,
) {
  const html = z
    .string()
    .min(1)
    .describe("A complete, self-contained HTML document.");
  const tools = [
    tool(
      HTML_PREVIEW_TOOL,
      `Load an HTML page in a headless browser and get back a PNG screenshot, contentHeight (the height the page needs at this width), and its console output, with uncaught errors and stack traces pointing into page.html. console.log is a fine way to report your own checks. Use it to check and iterate on a page before html_render, or on an \`\`\`artifact fence (mode "artifact": no script runs and nothing loads, exactly as the fence renders). ${PAGE_RULES}`,
      {
        html,
        width: z
          .number()
          .int()
          .optional()
          .describe(
            `Viewport width in CSS pixels, 240-1600. Defaults to ${HTML_RENDER_COLUMN_WIDTH}, the reply column; use 390 to check phones.`,
          ),
        appearance: z
          .enum(["dark", "light"])
          .optional()
          .describe("Theme to preview. Defaults to dark."),
        mode: z
          .enum(["render", "artifact"])
          .optional()
          .describe(
            'What the page will be: "render" (default) for html_render, "artifact" for an ```artifact fence.',
          ),
      },
      async (args) => {
        try {
          const result = await previewHtml(args, deps);
          if ("error" in result) return failure(result.error!);
          const summary = {
            width: result.width,
            contentHeight: result.contentHeight,
            capturedHeight: result.capturedHeight,
            ...(result.notes.length ? { notes: result.notes } : {}),
          };
          return {
            content: [
              {
                type: "image" as const,
                data: result.screenshot,
                mimeType: "image/png",
              },
              {
                type: "text" as const,
                text:
                  JSON.stringify(summary) +
                  (result.consoleMessages.length
                    ? `\nConsole:\n${consoleSummary(result.consoleMessages)}`
                    : "\nConsole: (empty)"),
              },
            ],
          };
        } catch (error) {
          return failure(`Preview failed: ${(error as Error).message}`);
        }
      },
    ),
    tool(
      HTML_RENDER_TOOL,
      `Show a finished HTML page (an interactive calculator, chart, table, diagram, mockup) inline in this session, under this turn's work and above your final reply; call it before writing that reply. Use it when the answer is better seen or played with than read, and when it needs script; a static picture can stay an \`\`\`artifact or \`\`\`svg fence. The reader already sees the page, so the reply should not announce it, say where it is, or restate it: add only what the page does not say. Preview with html_preview first. The frame fits the page's height at each reader's width; a height below the page's contentHeight caps the frame and the rest scrolls inside it. ${PAGE_RULES} ${HTML_LAYOUT_GUIDE} ${HTML_THEME_GUIDE}`,
      {
        html,
        title: z
          .string()
          .min(1)
          .max(HTML_RENDER_MAX_TITLE_LENGTH)
          .describe("Short name for the page."),
        height: z
          .number()
          .int()
          .describe(
            `The frame height in CSS pixels, ${HTML_RENDER_MIN_HEIGHT}-${HTML_RENDER_MAX_HEIGHT}. Use html_preview's contentHeight, or less to make long content scroll inside the frame.`,
          ),
      },
      async (args) => {
        try {
          const result = await renderHtml(
            { sessionId: ctx.sessionId, ...args },
            deps,
          );
          if ("error" in result) return failure(result.error);
          const errors = result.consoleMessages.filter(
            (m) => m.level === "error",
          );
          const message = [
            "Shown inline in the session. Do not link to it or describe where it is.",
            ...result.notes,
            ...(errors.length
              ? [
                  `The page logged errors while loading; fix them with html_preview and render again:\n${consoleSummary(errors)}`,
                ]
              : []),
          ].join("\n");
          // One JSON object: clients read `htmlRender` out of this text
          // (htmlRenderFromResult in the protocol package), and the server
          // ships it whole only under HTML_RENDER_RESULT_MAX_BYTES.
          const answer = (m: string) =>
            JSON.stringify({ htmlRender: result.htmlRender, message: m });
          let fitted = message;
          while (
            answer(fitted).length > HTML_RENDER_RESULT_MAX_BYTES &&
            fitted.length > 0
          )
            fitted = `${fitted.slice(0, Math.floor(fitted.length * 0.8))}…`;
          return text(answer(fitted));
        } catch (error) {
          return failure(`Render failed: ${(error as Error).message}`);
        }
      },
    ),
  ];
  return createSdkMcpServer({
    name: HTML_RENDER_SERVER,
    version: "1.0.0",
    tools,
  });
}
