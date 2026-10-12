/**
 * The headless browser that previews and measures agent HTML: one Chrome per
 * call, driven over the DevTools protocol, gone when the call ends.
 *
 * The page is served from a fixed fake origin by request interception, so
 * nothing is written to disk and the page's own URL never changes. Every
 * other main-frame navigation is refused, WebRTC is removed, and all traffic
 * goes through a proxy that only reaches public addresses (public-proxy.ts):
 * the page can load a CDN library but never this machine or its networks.
 */

import { access, mkdtemp, rm } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { MEASURE_EXPRESSION } from "./document";
import { startPublicProxy } from "./public-proxy";

const PAGE_URL = "https://page.opensession.invalid/page.html";
const VIEWPORT_HEIGHT = 600;
const LOAD_TIMEOUT_MS = 10_000;
const CALL_TIMEOUT_MS = 45_000;
const MAX_CONSOLE = 60;
const MAX_CONSOLE_TEXT = 600;
const MAX_CONCURRENT = 2;

const SETTLE_EXPRESSION =
  "(document.fonts?document.fonts.ready:Promise.resolve()).then(function(){return new Promise(function(r){requestAnimationFrame(function(){requestAnimationFrame(function(){setTimeout(r,120)})})})})";

export class BrowserUnavailableError extends Error {}

export interface ConsoleMessage {
  level: "log" | "info" | "warning" | "error";
  text: string;
}

const CANDIDATES = [
  "/usr/bin/google-chrome-stable",
  "/usr/bin/google-chrome",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/snap/bin/chromium",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
  "/Applications/Chromium.app/Contents/MacOS/Chromium",
];

async function findChrome(): Promise<string | undefined> {
  const configured =
    process.env.OPENSESSION_CHROME_PATH || process.env.CHROME_PATH;
  for (const path of configured ? [configured, ...CANDIDATES] : CANDIDATES) {
    try {
      await access(path, constants.X_OK);
      return path;
    } catch {
      // next
    }
  }
  return undefined;
}

let running = 0;
const waiting: Array<() => void> = [];
async function slot(): Promise<() => void> {
  if (running >= MAX_CONCURRENT)
    await new Promise<void>((resolve) => waiting.push(resolve));
  running++;
  return () => {
    running--;
    waiting.shift()?.();
  };
}

type Message = {
  id?: number;
  method?: string;
  params?: any;
  result?: any;
  error?: { message: string };
  sessionId?: string;
};

class Cdp {
  private nextId = 1;
  private pending = new Map<
    number,
    { resolve: (v: any) => void; reject: (e: Error) => void }
  >();
  readonly listeners = new Set<(message: Message) => void>();
  private constructor(private ws: WebSocket) {
    ws.addEventListener("message", (event) => {
      const message = JSON.parse(String(event.data)) as Message;
      if (message.id !== undefined) {
        const waiter = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) waiter?.reject(new Error(message.error.message));
        else waiter?.resolve(message.result);
        return;
      }
      for (const listener of this.listeners) listener(message);
    });
    ws.addEventListener("close", () => {
      for (const waiter of this.pending.values())
        waiter.reject(new Error("the browser closed"));
      this.pending.clear();
    });
  }
  static open(url: string): Promise<Cdp> {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(url);
      ws.addEventListener("open", () => resolve(new Cdp(ws)), { once: true });
      ws.addEventListener("error", () => reject(new Error("no DevTools")), {
        once: true,
      });
    });
  }
  send<T = any>(
    method: string,
    params: Record<string, unknown> = {},
    sessionId?: string,
  ): Promise<T> {
    const id = this.nextId++;
    return new Promise<T>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params, sessionId }));
    });
  }
  close() {
    this.ws.close();
  }
}

function remoteText(arg: any): string {
  if (!arg) return "";
  if (arg.type === "string") return String(arg.value);
  if ("value" in arg) return JSON.stringify(arg.value);
  return arg.description ?? arg.type ?? "";
}

export interface HeadlessPage {
  /** Load `html` (the full page) and return its settled content height. */
  load(html: string): Promise<number>;
  /** Resize the viewport and return the settled content height. */
  measureAt(width: number): Promise<number>;
  screenshot(width: number, height: number): Promise<string>;
  readonly consoleMessages: ConsoleMessage[];
  readonly notes: string[];
}

async function openPage(
  cdp: Cdp,
  width: number,
  appearance: "light" | "dark",
): Promise<HeadlessPage> {
  const { targetId } = await cdp.send("Target.createTarget", {
    url: "about:blank",
  });
  const { sessionId } = await cdp.send("Target.attachToTarget", {
    targetId,
    flatten: true,
  });
  const consoleMessages: ConsoleMessage[] = [];
  const notes: string[] = [];
  let omitted = 0;
  const push = (level: ConsoleMessage["level"], text: string) => {
    if (consoleMessages.length >= MAX_CONSOLE) return void omitted++;
    consoleMessages.push({ level, text: text.slice(0, MAX_CONSOLE_TEXT) });
  };
  let body = "";
  let loaded: (() => void) | undefined;
  cdp.listeners.add((message) => {
    if (message.sessionId !== sessionId) return;
    const p = message.params;
    switch (message.method) {
      case "Page.loadEventFired":
        loaded?.();
        break;
      case "Runtime.consoleAPICalled": {
        const level =
          p.type === "error" || p.type === "assert"
            ? "error"
            : p.type === "warning"
              ? "warning"
              : p.type === "info"
                ? "info"
                : "log";
        push(level, (p.args ?? []).map(remoteText).join(" "));
        break;
      }
      case "Runtime.exceptionThrown": {
        const d = p.exceptionDetails ?? {};
        push(
          "error",
          d.exception?.description ?? d.text ?? "Uncaught exception",
        );
        break;
      }
      case "Log.entryAdded": {
        const e = p.entry ?? {};
        if (e.level === "error" || e.level === "warning")
          push(e.level, e.url ? `${e.text} (${e.url})` : e.text);
        break;
      }
      case "Fetch.requestPaused": {
        const { requestId, request, resourceType, frameId } = p;
        const url = String(request?.url ?? "").split("#")[0];
        if (url === PAGE_URL) {
          void cdp
            .send(
              "Fetch.fulfillRequest",
              {
                requestId,
                responseCode: 200,
                responseHeaders: [
                  { name: "Content-Type", value: "text/html; charset=utf-8" },
                ],
                body: Buffer.from(body).toString("base64"),
              },
              sessionId,
            )
            .catch(() => {});
        } else if (resourceType === "Document" && frameId === targetId) {
          notes.push(`blocked a navigation to ${url}`);
          void cdp
            .send(
              "Fetch.failRequest",
              { requestId, errorReason: "BlockedByClient" },
              sessionId,
            )
            .catch(() => {});
        } else {
          void cdp
            .send("Fetch.continueRequest", { requestId }, sessionId)
            .catch(() => {});
        }
        break;
      }
    }
  });
  await cdp.send("Page.enable", {}, sessionId);
  await cdp.send("Runtime.enable", {}, sessionId);
  await cdp.send("Log.enable", {}, sessionId);
  await cdp.send(
    "Page.addScriptToEvaluateOnNewDocument",
    {
      source:
        "delete window.RTCPeerConnection;delete window.webkitRTCPeerConnection;",
      runImmediately: true,
    },
    sessionId,
  );
  await cdp.send(
    "Fetch.enable",
    {
      patterns: [
        { urlPattern: "https://page.opensession.invalid/*" },
        { urlPattern: "*", resourceType: "Document" },
      ],
    },
    sessionId,
  );
  await cdp.send(
    "Emulation.setEmulatedMedia",
    { features: [{ name: "prefers-color-scheme", value: appearance }] },
    sessionId,
  );
  const setSize = (w: number, h: number) =>
    cdp.send(
      "Emulation.setDeviceMetricsOverride",
      { width: w, height: h, deviceScaleFactor: 1, mobile: false },
      sessionId,
    );
  await setSize(width, VIEWPORT_HEIGHT);
  const evaluate = async (expression: string, awaitPromise = false) => {
    const res = await cdp.send(
      "Runtime.evaluate",
      { expression, awaitPromise, returnByValue: true },
      sessionId,
    );
    return res?.result?.value;
  };
  const settledHeight = async () => {
    await evaluate(SETTLE_EXPRESSION, true).catch(() => {});
    const value = await evaluate(MEASURE_EXPRESSION);
    return typeof value === "number" && Number.isFinite(value)
      ? Math.max(0, Math.ceil(value))
      : 0;
  };
  return {
    consoleMessages,
    notes,
    async load(html) {
      body = html;
      const didLoad = new Promise<boolean>((resolve) => {
        loaded = () => resolve(true);
        setTimeout(() => resolve(false), LOAD_TIMEOUT_MS);
      });
      const nav = await cdp.send("Page.navigate", { url: PAGE_URL }, sessionId);
      if (nav?.errorText)
        throw new Error(`the page could not be opened: ${nav.errorText}`);
      if (!(await didLoad))
        notes.push(
          `the load event had not fired after ${LOAD_TIMEOUT_MS / 1000}s; measured anyway`,
        );
      return settledHeight();
    },
    async measureAt(w) {
      await setSize(w, VIEWPORT_HEIGHT);
      return settledHeight();
    },
    async screenshot(w, h) {
      await setSize(w, h);
      await evaluate(SETTLE_EXPRESSION, true).catch(() => {});
      const { data } = await cdp.send(
        "Page.captureScreenshot",
        {
          format: "png",
          captureBeyondViewport: true,
          clip: { x: 0, y: 0, width: w, height: h, scale: 1 },
        },
        sessionId,
      );
      if (omitted)
        consoleMessages.push({
          level: "warning",
          text: `${omitted} more console messages were omitted.`,
        });
      omitted = 0;
      return data as string;
    },
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, what: string) {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${what} took longer than ${ms / 1000}s`)),
        ms,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

/**
 * Run `fn` against a fresh page in a fresh headless Chrome. Throws
 * BrowserUnavailableError when this host has no Chrome.
 */
export async function withHeadlessPage<T>(
  options: { width: number; appearance: "light" | "dark" },
  fn: (page: HeadlessPage) => Promise<T>,
): Promise<T> {
  const chrome = await findChrome();
  if (!chrome)
    throw new BrowserUnavailableError(
      "No Chrome or Chromium is installed on this host (set OPENSESSION_CHROME_PATH to use one elsewhere).",
    );
  const release = await slot();
  // A short TMPDIR: Chrome's singleton socket path overflows under a long
  // session scratch directory and the browser dies at start.
  const profile = await mkdtemp(join("/tmp", "os-html-"));
  const proxy = await startPublicProxy();
  let proc: ReturnType<typeof Bun.spawn> | undefined;
  let cdp: Cdp | undefined;
  try {
    proc = Bun.spawn(
      [
        chrome,
        "--headless=new",
        "--no-first-run",
        "--no-default-browser-check",
        "--disable-gpu",
        "--hide-scrollbars",
        "--mute-audio",
        "--block-new-web-contents",
        "--disable-extensions",
        "--disable-background-networking",
        "--disable-component-update",
        "--disable-sync",
        `--proxy-server=socks5://127.0.0.1:${proxy.port}`,
        // Loopback goes through the proxy too, where it is refused.
        "--proxy-bypass-list=<-loopback>",
        "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ...(process.getuid?.() === 0 ? ["--no-sandbox"] : []),
        "--remote-debugging-port=0",
        `--user-data-dir=${profile}`,
        "about:blank",
      ],
      {
        stdin: "ignore",
        stdout: "ignore",
        stderr: "pipe",
        env: { ...process.env, TMPDIR: "/tmp" },
      },
    );
    // stderr is read to the end, not just to the DevTools line: a pipe
    // closed under Chrome kills it on its next log line.
    const reader = (proc.stderr as ReadableStream<Uint8Array>).getReader();
    const endpoint = await withTimeout(
      (async () => {
        const decoder = new TextDecoder();
        let seen = "";
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          seen += decoder.decode(value, { stream: true });
          const match = /DevTools listening on (ws:\/\/\S+)/.exec(seen);
          if (match) return match[1]!;
          if (seen.length > 64 * 1024) seen = seen.slice(-4096);
        }
        throw new Error(
          `Chrome exited before it was ready: ${seen.trim().slice(-400)}`,
        );
      })(),
      15_000,
      "starting Chrome",
    );
    void (async () => {
      while (!(await reader.read().catch(() => ({ done: true }))).done);
    })();
    cdp = await Cdp.open(endpoint);
    const page = await openPage(cdp, options.width, options.appearance);
    return await withTimeout(fn(page), CALL_TIMEOUT_MS, "rendering the page");
  } finally {
    cdp?.close();
    proc?.kill();
    await Promise.race([
      proc?.exited,
      new Promise((resolve) => setTimeout(resolve, 3000)),
    ]);
    await proxy.close();
    await rm(profile, { recursive: true, force: true }).catch(() => {});
    release();
  }
}
