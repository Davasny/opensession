import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionPreviewSurface } from "./SessionPreviewSurface";

const STAGING_URL = "https://preview.example.test/path?record=1";
const shareLink = () => {};

test("an embeddable staging deployment renders in a browser pane", () => {
  const html = renderToStaticMarkup(
    <SessionPreviewSurface
      surface={{
        kind: "staging",
        deployment: { status: "Building", embeddable: true },
        url: STAGING_URL,
        shareLink,
      }}
    />,
  );

  expect(html).toContain("Building…");
  expect(html).toContain('aria-label="Preview environment address"');
  expect(html).toContain(`value="${STAGING_URL.replace("&", "&amp;")}"`);
  expect(html).toContain(`src="${STAGING_URL.replace("&", "&amp;")}"`);
  expect(html).toContain(
    'allow="camera; microphone; display-capture; fullscreen; autoplay; clipboard-write"',
  );
  expect(html).toContain('aria-label="Copy preview link"');
  expect(html).toContain('aria-label="Reload Preview environment"');
  expect(html).toContain(
    'aria-label="Open Preview environment in a new browser tab"',
  );
});

test("a non-embeddable deployment keeps the first-party fallback", () => {
  const html = renderToStaticMarkup(
    <SessionPreviewSurface
      surface={{
        kind: "staging",
        deployment: { status: "Ready" },
        url: STAGING_URL,
        shareLink,
      }}
    />,
  );

  expect(html).not.toContain("<iframe");
  expect(html).toContain("Test this PR on real infra");
  expect(html).toContain("Open staging");
  expect(html).toContain("Copy link");
  expect(html).toContain(`href="${STAGING_URL.replace("&", "&amp;")}"`);
});

test("SessionViewer keeps preview selection and state ownership", async () => {
  const viewer = await Bun.file(
    new URL("../session-viewer/SessionViewerMainRegion.tsx", import.meta.url),
  ).text();
  const branch = viewer.slice(
    viewer.indexOf("{showPortal && portalTarget ? ("),
    viewer.indexOf(") : showAssets ? ("),
  );
  const portal = branch.indexOf('kind: "portal"');
  const staging = branch.indexOf('kind: "staging"');

  expect(branch).toContain("<SessionPreviewSurface");
  expect(portal).toBeGreaterThan(-1);
  expect(staging).toBeGreaterThan(portal);
  expect(branch).toContain("deployment: staging");
  expect(branch).toContain("url: browserTab.url");
  expect(branch).toContain("shareLink,");
  expect(branch).toContain('kind: "browser", url: browserTab.url');
  // Every surface keeps its page in the app-wide frame layer.
  expect(branch.split("frameScope={frameScope}")).toHaveLength(4);
});

test("a kept preview leaves its frame to the app-wide layer", () => {
  const html = renderToStaticMarkup(
    <SessionPreviewSurface
      surface={{
        kind: "staging",
        deployment: { status: "Ready", embeddable: true },
        url: STAGING_URL,
        shareLink,
      }}
      frameScope="ws-1"
    />,
  );

  expect(html).toContain(`value="${STAGING_URL.replace("&", "&amp;")}"`);
  expect(html).not.toContain("<iframe");
});

test("a link opened in the Browser tab renders in a browser pane", () => {
  const html = renderToStaticMarkup(
    <SessionPreviewSurface
      surface={{ kind: "browser", url: "https://acme.example.test/page" }}
    />,
  );

  expect(html).toContain('src="https://acme.example.test/page"');
  expect(html).toContain('aria-label="Browser address"');
});
