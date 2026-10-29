import type { FrameRect } from "./browser-annotation";
import { os1Shell } from "./os1-shell";

function loadImage(src: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error("Could not read the screenshot"));
    image.src = src;
  });
}

/**
 * A screenshot of the framed page with the commented box outlined, the way
 * the person saw it, or null when this client cannot take one. `frame` is the
 * frame's box in the window, `box` the outline in frame pixels.
 */
export async function captureMarkedFrame(
  frame: DOMRect,
  box: FrameRect,
): Promise<File | null> {
  const capture = os1Shell()?.capturePage;
  if (!capture) return null;
  const dataUrl = await capture({
    x: Math.round(frame.left),
    y: Math.round(frame.top),
    width: Math.round(frame.width),
    height: Math.round(frame.height),
  }).catch(() => null);
  if (!dataUrl) return null;
  const image = await loadImage(dataUrl);
  const canvas = document.createElement("canvas");
  canvas.width = image.naturalWidth;
  canvas.height = image.naturalHeight;
  const context = canvas.getContext("2d");
  if (!context) return null;
  context.drawImage(image, 0, 0);
  const scale = image.naturalWidth / Math.max(1, frame.width);
  const accent =
    getComputedStyle(document.documentElement)
      .getPropertyValue("--blue")
      .trim() || "royalblue";
  context.strokeStyle = accent;
  context.lineWidth = 3 * scale;
  context.strokeRect(
    box.x * scale,
    box.y * scale,
    box.width * scale,
    box.height * scale,
  );
  const blob = await new Promise<Blob | null>((resolve) =>
    canvas.toBlob(resolve, "image/png"),
  );
  return blob
    ? new File([blob], `browser-comment-${Date.now()}.png`, {
        type: "image/png",
      })
    : null;
}
