/**
 * The DOM half of an artifact block: the sandboxed frame, its controls
 * (Source toggle, expand) and the height grip under it. The document inside
 * the frame and the policy on it come from artifact-document.ts, which is
 * where the security lives; this file only puts that document into an
 * <iframe sandbox> and never reads out of it, except for one height read off
 * the inert probe frame described there.
 *
 * The block reads as part of the reply: no border or header, the page on
 * the transcript's own background, the controls on hover. It takes the
 * document's own height, measured at the block's width and again whenever
 * that width changes, until the reader drags the grip.
 */

import { expandIconMarkup } from "../components/icons";
import {
  ARTIFACT_DEFAULT_HEIGHT,
  ARTIFACT_PROBE_SANDBOX,
  ARTIFACT_SANDBOX,
  artifactHtmlDocument,
  artifactSvgDocument,
  clampArtifactHeight,
  svgArtifactSize,
  type ArtifactTheme,
} from "./artifact-document";
import { openBlockExpand } from "./block-expand";
import type { UpgradeRoot } from "./fence-upgraders";
import { readHtmlTheme } from "./html-theme";

const WRAP_CLASS = "md-artifact-wrap";
const FRAME_CLASS = "md-artifact-frame";
const FRAME_SELECTOR = `iframe.${FRAME_CLASS}`;
const PROBE_TIMEOUT_MS = 4000;

interface FrameSpec {
  srcdoc: string;
  label: string;
}

function readTheme(): ArtifactTheme {
  const theme = readHtmlTheme();
  return { scheme: theme.appearance, variables: theme.variables };
}

function frameSpec(source: string, lang: string): FrameSpec {
  const theme = readTheme();
  return lang === "svg"
    ? { srcdoc: artifactSvgDocument(source, theme), label: "SVG" }
    : { srcdoc: artifactHtmlDocument(source, theme), label: "Artifact" };
}

/**
 * A frame loads exactly once, with the artifact. A later load means the
 * document navigated itself, which with scripts off and every link aimed
 * at a window the sandbox refuses takes a click on a link the author
 * marked `_self`; the frame goes back to the artifact, same size, same
 * place. The grip and the dialog find the frame through its container, so
 * the swap is invisible to them.
 */
function createFrame(spec: FrameSpec): HTMLIFrameElement {
  const frame = document.createElement("iframe");
  frame.className = FRAME_CLASS;
  frame.title = `${spec.label} preview`;
  // The attribute is set before srcdoc so the document never loads outside
  // the sandbox.
  frame.setAttribute("sandbox", ARTIFACT_SANDBOX);
  frame.referrerPolicy = "no-referrer";
  frame.srcdoc = spec.srcdoc;
  let loaded = false;
  frame.addEventListener("load", () => {
    if (!loaded) {
      loaded = true;
      return;
    }
    const fresh = createFrame(spec);
    fresh.style.cssText = frame.style.cssText;
    if (frame.dataset.fill !== undefined) fresh.dataset.fill = "";
    frame.replaceWith(fresh);
  });
  return frame;
}

/**
 * The document's laid-out height at `width`, from a hidden probe frame: the
 * same `srcdoc` under ARTIFACT_PROBE_SANDBOX, off screen, removed once read.
 * Null when it cannot be read in time.
 */
export function measureArtifactHeight(
  srcdoc: string,
  width: number,
): Promise<number | null> {
  return new Promise((resolve) => {
    const probe = document.createElement("iframe");
    probe.setAttribute("sandbox", ARTIFACT_PROBE_SANDBOX);
    probe.setAttribute("aria-hidden", "true");
    probe.tabIndex = -1;
    probe.referrerPolicy = "no-referrer";
    probe.style.cssText = `position:fixed;left:-100000px;top:0;width:${width}px;height:1px;border:0;visibility:hidden;pointer-events:none`;
    let done = false;
    const finish = (height: number | null) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      probe.remove();
      resolve(height);
    };
    const timer = setTimeout(() => finish(null), PROBE_TIMEOUT_MS);
    probe.addEventListener(
      "load",
      () => {
        try {
          const root = probe.contentDocument?.documentElement;
          finish(root ? Math.ceil(root.scrollHeight) : null);
        } catch {
          finish(null);
        }
      },
      { once: true },
    );
    probe.srcdoc = srcdoc;
    document.body.append(probe);
  });
}

function button(
  className: string,
  label: string,
  html: string,
): HTMLButtonElement {
  const el = document.createElement("button");
  el.type = "button";
  el.className = className;
  el.title = label;
  el.setAttribute("aria-label", label);
  el.innerHTML = html;
  return el;
}

/** Drag or arrow the frame's height. The grip is a real button so it is in
 *  the tab order; pointer capture keeps a drag alive over the frame. */
function attachGrip(
  grip: HTMLButtonElement,
  body: HTMLElement,
  wrap: HTMLElement,
): void {
  const frame = () => body.querySelector<HTMLIFrameElement>(FRAME_SELECTOR);
  const height = () => frame()?.getBoundingClientRect().height ?? 0;
  const setHeight = (next: number) => {
    const el = frame();
    if (!el) return;
    el.style.height = `${clampArtifactHeight(next)}px`;
    wrap.dataset.sized = "manual";
  };
  let start: { y: number; height: number } | null = null;
  grip.addEventListener("pointerdown", (e) => {
    if (e.button !== 0) return;
    start = { y: e.clientY, height: height() };
    grip.setPointerCapture(e.pointerId);
    wrap.dataset.resizing = "";
    e.preventDefault();
  });
  grip.addEventListener("pointermove", (e) => {
    if (!start) return;
    setHeight(start.height + (e.clientY - start.y));
  });
  const end = () => {
    start = null;
    delete wrap.dataset.resizing;
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);
  grip.addEventListener("keydown", (e) => {
    const step = e.shiftKey ? 120 : 40;
    if (e.key === "ArrowDown") setHeight(height() + step);
    else if (e.key === "ArrowUp") setHeight(height() - step);
    else return;
    e.preventDefault();
  });
}

/** Each block's width watcher, released by `releaseArtifactBlocks`. Keyed
 *  by object so the release can take the registry's plain root type. */
const watchers = new WeakMap<object, ResizeObserver>();

/** Stop watching every block under `root`, before its DOM is discarded. */
export function releaseArtifactBlocks(root: UpgradeRoot): void {
  for (const wrap of Array.from(root.querySelectorAll(`.${WRAP_CLASS}`))) {
    watchers.get(wrap)?.disconnect();
    watchers.delete(wrap);
  }
}

/** Fit the frame to its document at the body's width, and again whenever
 *  that width changes, until the reader sizes it by hand. */
function autoSize(
  wrap: HTMLElement,
  body: HTMLElement,
  spec: FrameSpec,
  initial: number,
) {
  let measuredAt = -1;
  let pending = 0;
  const fit = async () => {
    const width = Math.round(body.clientWidth);
    if (width <= 0 || width === measuredAt) return;
    if (wrap.dataset.sized === "manual") return;
    measuredAt = width;
    const run = ++pending;
    const height = await measureArtifactHeight(spec.srcdoc, width);
    if (run !== pending || height === null || !wrap.isConnected) return;
    if (wrap.dataset.sized === "manual") return;
    const frame = body.querySelector<HTMLIFrameElement>(FRAME_SELECTOR);
    if (frame) frame.style.height = `${clampArtifactHeight(height)}px`;
    wrap.dataset.sized = "auto";
  };
  const frame = body.querySelector<HTMLIFrameElement>(FRAME_SELECTOR);
  if (frame) frame.style.height = `${initial}px`;
  const observer = new ResizeObserver(() => void fit());
  observer.observe(body);
  watchers.set(wrap, observer);
}

/**
 * Replace `pre` with the block, keeping `pre` inside it (hidden) for the
 * Source view and the copy control.
 */
export function mountArtifactBlock(
  pre: HTMLElement,
  source: string,
  lang: string,
): void {
  const spec = frameSpec(source, lang);
  const wrap = document.createElement("div");
  wrap.className = WRAP_CLASS;
  wrap.dataset.view = "preview";
  wrap.setAttribute("role", "figure");
  wrap.setAttribute("aria-label", spec.label);

  const head = document.createElement("div");
  head.className = "md-artifact-head";
  const sourceToggle = document.createElement("button");
  sourceToggle.type = "button";
  sourceToggle.className = "md-artifact-btn";
  sourceToggle.textContent = "Source";
  sourceToggle.setAttribute("aria-pressed", "false");
  sourceToggle.addEventListener("click", () => {
    const showing = wrap.dataset.view === "source";
    wrap.dataset.view = showing ? "preview" : "source";
    sourceToggle.setAttribute("aria-pressed", String(!showing));
  });
  const expand = button(
    "md-artifact-btn md-artifact-expand",
    `Expand ${spec.label.toLowerCase()}`,
    expandIconMarkup(16),
  );
  expand.addEventListener("click", () => {
    openBlockExpand({
      title: spec.label,
      fill: true,
      mount(host) {
        const large = createFrame(spec);
        large.dataset.fill = "";
        host.append(large);
        return () => host.replaceChildren();
      },
    });
  });
  head.append(sourceToggle, expand);

  const body = document.createElement("div");
  body.className = "md-artifact-body";
  const frame = createFrame(spec);
  const grip = button("md-artifact-grip", "Resize preview", "");
  body.append(frame, grip);
  attachGrip(grip, body, wrap);

  // The block takes the fence's place first, then takes the fence in: the
  // other way round, `pre` has already left the document by the time it
  // is asked to be replaced.
  pre.replaceWith(wrap);
  wrap.append(head, body, pre);

  // Until the probe answers, an SVG takes its declared aspect ratio and
  // anything else the default, so the first paint is already close.
  let initial = ARTIFACT_DEFAULT_HEIGHT;
  if (lang === "svg") {
    const size = svgArtifactSize(source);
    const width = body.clientWidth;
    if (size && width > 0)
      initial = clampArtifactHeight((width * size.h) / size.w);
  }
  autoSize(wrap, body, spec, initial);
}
