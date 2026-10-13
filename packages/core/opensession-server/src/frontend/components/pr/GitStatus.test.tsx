import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PrDetails } from "../../lib/types";
import { GitStatusRows } from "./GitStatus";

// SAFETY: GitStatusRows only reads the fields set here; the rest of
// PrDetails is irrelevant to the status row under test.
const pr = (over: Partial<PrDetails>) =>
  ({
    number: 7,
    url: "https://github.com/acme/app/pull/7",
    title: "Example",
    state: "OPEN",
    isDraft: false,
    baseRefName: "main",
    checks: [],
    ...over,
  }) as PrDetails;

const render = (details: PrDetails) =>
  renderToStaticMarkup(
    <GitStatusRows
      git={null}
      pr={details}
      sessionId="s1"
      onRefresh={() => {}}
      onMerge={() => {}}
      onMarkReady={() => {}}
    />,
  );

test("a draft PR offers Ready for review instead of Merge", () => {
  const html = render(pr({ isDraft: true }));
  expect(html).toContain("Ready for review");
  expect(html).not.toContain(">Merge<");
});

test("a ready PR offers Merge, not Ready for review", () => {
  const html = render(pr({ isDraft: false }));
  expect(html).toContain(">Merge<");
  expect(html).not.toContain("Ready for review");
});

test("merge choices put auto-merge on the button and offer cancel when it is on", () => {
  const html = renderToStaticMarkup(
    <GitStatusRows
      git={null}
      pr={pr({
        autoMerge: { method: "squash", enabledBy: "acme" },
      })}
      sessionId="s1"
      onRefresh={() => {}}
      onMerge={() => {}}
      merge={{
        primary: "auto",
        all: ["auto", "cancel-auto", "force"],
        onChoose: () => {},
      }}
    />,
  );
  expect(html).toContain(">Auto-merge<");
  expect(html).toContain("Auto-merge on by acme");
  expect(html).toContain(">Cancel<");
  expect(html).toContain('aria-label="Merge options"');
});
