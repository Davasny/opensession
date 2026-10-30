import { z } from "zod";

// The link each workspace's Browser tab shows, kept on this device. The tab
// itself comes back after a reload (active-view-tab.ts), so its link has to
// come back with it, or the tab reopens with nothing to show.
const KEY = "opensession-browser-tab-urls";

/** Workspaces kept, most recent last. Older ones fall back to their preview. */
const LIMIT = 20;

const StoredUrls = z.record(z.string(), z.string());

export function readBrowserTabUrls(): Record<string, string> {
  try {
    const stored = StoredUrls.safeParse(
      JSON.parse(localStorage.getItem(KEY) || "{}"),
    );
    return stored.success ? stored.data : {};
  } catch {
    return {};
  }
}

export function saveBrowserTabUrls(urls: Record<string, string>): void {
  try {
    const kept = Object.entries(urls).slice(-LIMIT);
    localStorage.setItem(KEY, JSON.stringify(Object.fromEntries(kept)));
  } catch {
    /* private mode / quota: the in-memory link still works */
  }
}
