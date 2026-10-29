import type { ImageRegion } from "./image-region-comment";

export interface ImageRegionCommentRequest {
  sessionId: string;
  src: string;
  region: ImageRegion;
  text: string;
}

export type ImageRegionCommentHandler = (
  request: ImageRegionCommentRequest,
) => Promise<void>;

const handlers = new Map<string, ImageRegionCommentHandler>();

/** Register the send path owned by one mounted session viewer. */
export function registerImageRegionCommentHandler(
  sessionId: string,
  handler: ImageRegionCommentHandler,
): () => void {
  handlers.set(sessionId, handler);
  return () => {
    if (handlers.get(sessionId) === handler) handlers.delete(sessionId);
  };
}

export function canCommentOnImageRegion(sessionId?: string): boolean {
  return Boolean(sessionId && handlers.has(sessionId));
}

/** Dispatch from the global lightbox back to the session that owns the image. */
export async function submitImageRegionComment(
  request: ImageRegionCommentRequest,
): Promise<void> {
  const handler = handlers.get(request.sessionId);
  if (!handler) throw new Error("That session is no longer open");
  await handler(request);
}

/** A comment made outside the transcript (a Browser tab page) that goes to
 *  the chat as its own message, with any screenshot beside it. */
export interface PageCommentRequest {
  sessionId: string;
  text: string;
  files: File[];
}

type PageCommentHandler = (request: PageCommentRequest) => Promise<void>;

const pageHandlers = new Map<string, PageCommentHandler>();

export function registerPageCommentHandler(
  sessionId: string,
  handler: PageCommentHandler,
): () => void {
  pageHandlers.set(sessionId, handler);
  return () => {
    if (pageHandlers.get(sessionId) === handler) pageHandlers.delete(sessionId);
  };
}

export function canCommentOnPage(sessionId?: string): boolean {
  return Boolean(sessionId && pageHandlers.has(sessionId));
}

export async function submitPageComment(
  request: PageCommentRequest,
): Promise<void> {
  const handler = pageHandlers.get(request.sessionId);
  if (!handler) throw new Error("That session is no longer open");
  await handler(request);
}
