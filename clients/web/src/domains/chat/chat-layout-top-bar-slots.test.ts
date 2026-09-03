/**
 * Where the layout's two injected header slots end up.
 *
 * `ChatLayout` restates `topBarAccessory` in the mobile drawer's glyph row,
 * which seats icon-sized controls beside the close button. The activation
 * suggestions pill is a full pill and has no seat there, so it takes
 * `topBarPill`, which the top bar is the only reader of.
 *
 * Asserted against the source rather than a render: the layout mounts most of
 * the app's stores, the router and the sidebar, and what is worth holding shut
 * is one line of prop wiring. `routes.tsx` is read alongside it so a
 * composition that puts the pill back in the accessory fails here rather than
 * in the drawer.
 */

import { describe, expect, test } from "bun:test";

const layoutSource = await Bun.file(
  new URL("./chat-layout.tsx", import.meta.url),
).text();
const routesSource = await Bun.file(
  new URL("../../routes.tsx", import.meta.url),
).text();

/** The expression `notificationsAction` is handed, whitespace collapsed. */
function drawerGlyphRowSource(): string {
  const match = /notificationsAction=\{([\s\S]*?)\n\s{6}\}/.exec(layoutSource);
  expect(
    match,
    "chat-layout.tsx no longer feeds notificationsAction",
  ).not.toBeNull();
  return (match?.[1] ?? "").replace(/\s+/g, " ").trim();
}

describe("ChatLayout top-bar slots", () => {
  test("the drawer glyph row is fed the accessory and nothing else", () => {
    const fed = drawerGlyphRowSource();
    expect(fed).toContain("topBarAccessory");
    expect(fed).not.toContain("topBarPill");
  });

  test("the top bar renders the pill slot", () => {
    expect(layoutSource).toContain("{topBarPill}");
  });

  test("the route composes the pill into the pill slot", () => {
    expect(routesSource).toContain(
      "topBarPill={<ActivationSuggestionsPillHost />}",
    );
    expect(routesSource).toContain("topBarAccessory={<NotificationsBell />}");
  });
});
