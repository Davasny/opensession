// Browser tab annotations (the web app's lib/browser-annotation.ts). The web
// app comments on pages it frames, which are cross-origin and so closed to
// it. The shell can reach into them: it adds this responder to each page the
// app window frames directly, so a comment can name the element under it, and
// it screenshots the window for the comment's picture.

// Runs in the framed page. It answers only its own parent, only to that
// parent's origin, and only says what is at one point: the element's
// selector, a little of its text, and its box.
function frameInspectResponder() {
  if (window.__os1FrameInspect || window.parent === window) return;
  window.__os1FrameInspect = true;
  const clip = (text, max) =>
    text.length > max ? `${text.slice(0, max - 3)}...` : text;
  const part = (el) => {
    let name = el.localName;
    if (el.id && /^[A-Za-z][\w-]*$/.test(el.id)) return `${name}#${el.id}`;
    const classes = Array.from(el.classList)
      .filter((c) => /^[A-Za-z_-][\w-]*$/.test(c))
      .slice(0, 2);
    if (classes.length) name += `.${classes.join(".")}`;
    return name;
  };
  const selectorFor = (el) => {
    const parts = [];
    for (let node = el; node && parts.length < 4; node = node.parentElement) {
      if (node === document.body || node === document.documentElement) break;
      parts.unshift(part(node));
      if (node.id) break;
    }
    return clip(parts.join(" > ") || el.localName, 300);
  };
  const textOf = (el) =>
    clip(
      (
        el.getAttribute("aria-label") ||
        el.getAttribute("alt") ||
        el.getAttribute("placeholder") ||
        el.innerText ||
        el.textContent ||
        ""
      )
        .replace(/\s+/g, " ")
        .trim(),
      200,
    );
  window.addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== window.parent || !data) return;
    if (data.type !== "opensession:inspect" || typeof data.id !== "string")
      return;
    const x = Number(data.x);
    const y = Number(data.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    const el = document.elementFromPoint(x, y);
    const box = el?.getBoundingClientRect();
    const element =
      el && box
        ? {
            selector: selectorFor(el),
            tag: el.localName.slice(0, 40),
            text: textOf(el),
            rect: {
              x: Math.round(box.left),
              y: Math.round(box.top),
              width: Math.round(box.width),
              height: Math.round(box.height),
            },
          }
        : null;
    window.parent.postMessage(
      {
        type: "opensession:inspected",
        id: data.id,
        element,
        scroll: { x: window.scrollX, y: window.scrollY },
        viewport: { width: window.innerWidth, height: window.innerHeight },
      },
      event.origin,
    );
  });
}

const FRAME_INSPECT_SCRIPT = `(${frameInspectResponder.toString()})();`;

/** A capture rectangle from the renderer, in DIPs, or null when malformed. */
function captureRect(raw, zoomFactor) {
  if (!raw || typeof raw !== "object") return null;
  const zoom = Number.isFinite(zoomFactor) && zoomFactor > 0 ? zoomFactor : 1;
  const values = ["x", "y", "width", "height"].map((key) => Number(raw[key]));
  if (!values.every(Number.isFinite)) return null;
  const [x, y, width, height] = values.map((value) => Math.round(value * zoom));
  if (width <= 0 || height <= 0 || x < 0 || y < 0) return null;
  return { x, y, width, height };
}

module.exports = { FRAME_INSPECT_SCRIPT, frameInspectResponder, captureRect };
