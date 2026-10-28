import { expect, test } from "bun:test";
import { webLink } from "./LinkContextMenu";

const ORIGIN = "https://app.example.test";

test("a web link to another site is offered", () => {
  expect(webLink("https://acme.example.test/a?b=1", ORIGIN)).toBe(
    "https://acme.example.test/a?b=1",
  );
});

test("links into this app, other schemes, and no link are not", () => {
  expect(webLink(`${ORIGIN}/session/x`, ORIGIN)).toBeNull();
  expect(webLink("mailto:a@example.test", ORIGIN)).toBeNull();
  expect(webLink(null, ORIGIN)).toBeNull();
});
