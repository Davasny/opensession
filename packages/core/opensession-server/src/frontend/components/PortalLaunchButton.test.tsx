import { expect, test } from "bun:test";
import { renderToStaticMarkup } from "react-dom/server";
import type { PreviewStatus } from "../lib/api";
import { launchablePortals, PortalLaunchButton } from "./PortalLaunchButton";

const noop = () => {};
const start = async () => {};

const status: PreviewStatus = {
  services: [
    {
      name: "web",
      key: "WEB_PORT",
      port: 3000,
      running: true,
      pids: [42],
      previewUrl: "https://web.example.test",
    },
  ],
  portalRecipes: [
    {
      id: "web",
      name: "Web app",
      command: "./start.sh",
      serviceKey: "WEB_PORT",
    },
    { id: "docs", name: "Docs", command: "./docs.sh", serviceKey: "DOCS_PORT" },
    { id: "empty", name: "Nothing to run" },
  ],
};

function render(value: PreviewStatus | null, launching: string | null = null) {
  return renderToStaticMarkup(
    <PortalLaunchButton
      sessionId="session-1"
      status={value}
      launching={launching}
      onLaunchingChange={noop}
      onStart={start}
      onOpen={noop}
    />,
  );
}

test("only recipes with something to run are launchable, live ones carry a target", () => {
  const portals = launchablePortals("session-1", status);
  expect(portals.map((portal) => portal.recipe.id)).toEqual(["web", "docs"]);
  expect(portals[0].target?.url).toBe("https://web.example.test");
  expect(portals[1].target).toBeNull();
});

test("the button hides until the repository declares a Portal", () => {
  expect(render(null)).toBe("");
  expect(render({ services: [], portalRecipes: [] })).toBe("");
});

test("one declared Portal is a single start button", () => {
  const html = render({
    services: [],
    portalRecipes: [{ id: "web", name: "Web app", command: "./start.sh" }],
  });
  expect(html).toContain('aria-label="Start Web app"');
});

test("several declared Portals open a menu, and say which one is starting", () => {
  expect(render(status)).toContain('aria-label="Start a Portal"');
  expect(render(status, "docs")).toContain('aria-label="Starting Docs"');
});
