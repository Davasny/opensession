/**
 * Assets tab — the session's scratch folder of agent-produced artifacts
 * (HTML/JS visualizations, reports, diagrams, sample data; see
 * src/server/session-assets.ts). Split view: file tree beside the preview on
 * desktop, folded into one row above it on phones.
 *
 * This is the place you go to sit with the folder. One file on its own arrives
 * over the conversation instead, in `AssetOverlay` — and both render the same
 * `AssetPreview` with the same action menu, while placing metadata where it
 * best fits each surface.
 */

import React, { useCallback, useEffect, useState } from "react";
import type { SessionAssetFile } from "../lib/api";
import { useSessionAssetsResource } from "../hooks/useApiResources";
import type { WSServerMessage } from "../lib/types";
import type { NewSessionPrefill } from "../lib/new-session-link";
import { Button } from "../ui/button";
import { AssetActions, AssetPreview } from "./AssetView";
import { AssetsTree } from "./DeferredDiff";
import { resolvedAssetPath } from "../lib/asset-preview";
import { useIsPhone } from "../hooks/useIsPhone";
import { Collapsible, collapsiblePanelClasses } from "../ui/collapsible";
import { IconChevronRight } from "./icons";

/** Lives in SessionViewer (not the panel) so the tab button can show/hide on
 * the file count without the panel being mounted. */
export function useSessionAssets(
  sessionId: string,
  addHandler: (h: (msg: WSServerMessage) => void) => () => void,
) {
  const { data: files = [], mutate } = useSessionAssetsResource(sessionId);
  const refresh = useCallback(() => {
    void mutate();
  }, [mutate]);
  useEffect(
    () =>
      addHandler((msg) => {
        if (msg.type === "assets_changed" && msg.sessionId === sessionId)
          refresh();
      }),
    [addHandler, sessionId, refresh],
  );
  return { files, refresh };
}

export function AssetsPanel({
  sessionId,
  files,
  refresh,
  selectedPath = null,
  onSelectPath,
  onOpenNewSession,
}: {
  sessionId: string;
  files: SessionAssetFile[];
  refresh: () => void;
  /** Controlled selection — the file the overlay was promoted from. */
  selectedPath?: string | null;
  onSelectPath: (path: string | null) => void;
  onOpenNewSession: (prefill: NewSessionPrefill) => void;
}) {
  const paths = files.map((f) => f.path);
  const selected = resolvedAssetPath(paths, selectedPath);
  // Keep SessionViewer aligned with tree navigation. Without this, promoting
  // the same overlay twice can be a React no-op after the tree selected
  // another file in between.
  useEffect(() => {
    if (selected !== selectedPath) onSelectPath(selected);
  }, [selected, selectedPath, onSelectPath]);

  const file = files.find((f) => f.path === selected) || null;
  const isPhone = useIsPhone();
  const [filesOpen, setFilesOpen] = useState(false);
  const treeRows =
    paths.length +
    new Set(
      paths.flatMap((p) =>
        p
          .split("/")
          .slice(0, -1)
          .map((_, i, parts) => parts.slice(0, i + 1).join("/")),
      ),
    ).size;

  if (!files.length) {
    return (
      <div className="flex h-full min-h-[240px] flex-col items-center justify-center gap-1 px-6 text-center">
        <div className="text-label text-dim">No assets yet</div>
        <div className="max-w-[360px] text-label text-faint">
          Ask the agent to save a visualization, report, or demo page here. It
          writes files with opensession-assets' write_asset and they preview
          live in this tab.
        </div>
      </div>
    );
  }

  const tree = (
    <AssetsTree
      key={paths.join("\n")}
      paths={paths}
      selected={selected}
      onSelect={(path: string) => {
        onSelectPath(path);
        setFilesOpen(false);
      }}
    />
  );
  const refreshButton = (
    <Button
      variant="ghost"
      size="sm"
      className="shrink-0 text-faint"
      onClick={refresh}
      title="Refresh the file list"
    >
      Refresh
    </Button>
  );
  const filesLabel = (
    <span className="text-label font-semibold text-faint">
      Files · {files.length}
    </span>
  );

  return (
    <div className="flex h-full min-h-0 flex-col desktop:flex-row">
      {isPhone ? (
        // A phone has no width for a column, and a list stacked over the
        // preview left a sliver of each. The list folds into one row and
        // closes again once a file is picked.
        <Collapsible.Root
          open={filesOpen}
          onOpenChange={setFilesOpen}
          className="shrink-0 border-b border-line"
        >
          <div className="flex items-center gap-2 pr-2">
            <Collapsible.Trigger className="focus-ring group flex min-h-11 min-w-0 flex-1 items-center gap-1.5 px-3">
              <IconChevronRight
                size={14}
                className="shrink-0 text-faint transition-transform duration-[var(--dur-micro)] ease-[var(--ease)] group-data-[panel-open]:rotate-90"
              />
              {filesLabel}
            </Collapsible.Trigger>
            {refreshButton}
          </div>
          <Collapsible.Panel className={collapsiblePanelClasses}>
            {/* The tree is virtualized and needs a definite height: one
                row per file and folder, capped at half the screen. */}
            <div
              className="px-1 pb-1.5"
              style={{ height: `min(50vh, ${treeRows * 30 + 6}px)` }}
            >
              {tree}
            </div>
          </Collapsible.Panel>
        </Collapsible.Root>
      ) : (
        // Desktop: the list is a full-height column beside the preview, so
        // neither one is cut down to fit the other.
        <div className="flex w-[280px] shrink-0 flex-col border-r border-line">
          <div className="flex items-center justify-between px-3 pt-2 pb-1">
            {filesLabel}
            {refreshButton}
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-1 pb-1.5">
            {tree}
          </div>
        </div>
      )}
      {file ? (
        <div className="flex min-h-0 min-w-0 flex-1 flex-col">
          <AssetActions
            sessionId={sessionId}
            file={file}
            refresh={refresh}
            showSize
          />
          <AssetPreview
            sessionId={sessionId}
            file={file}
            onOpenNewSession={onOpenNewSession}
          />
        </div>
      ) : null}
    </div>
  );
}
