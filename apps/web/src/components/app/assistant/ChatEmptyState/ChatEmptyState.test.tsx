/**
 * Tests for the `ChatEmptyState` presentational layout.
 *
 * Mirrors the project convention used by the other component tests in this
 * tree: bun:test + react-dom/server (no @testing-library available). Static
 * markup is enough for slot/composition assertions.
 *
 * Conversation-starter grid rendering and `onSelectStarter` wiring are no
 * longer tested here — starters moved to `ChatBody` (rendered below the
 * composer) as part of LUM-1566. The centering layout is also owned by
 * `ChatBody` now, so the "layout invariant" tests live there instead.
 */

import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { DEFAULT_EMPTY_STATE_GREETING } from "@/domains/chat/lib/empty-state-constants.js";

import { ChatEmptyState } from "@/components/app/assistant/ChatEmptyState/ChatEmptyState.js";

function renderEmptyState(
  props: Partial<Parameters<typeof ChatEmptyState>[0]> = {},
): string {
  return renderToStaticMarkup(createElement(ChatEmptyState, props));
}

/**
 * `renderToStaticMarkup` HTML-encodes the apostrophe in the default greeting
 * (`I'm` → `I&#x27;m`). Tests compare against the encoded form so we don't
 * accidentally couple to the literal source string.
 */
const DEFAULT_GREETING_HTML = DEFAULT_EMPTY_STATE_GREETING.replace(
  /'/g,
  "&#x27;",
);

describe("ChatEmptyState — greeting", () => {
  test("renders DEFAULT_EMPTY_STATE_GREETING when no greeting prop is given", () => {
    const html = renderEmptyState();
    expect(html).toContain(DEFAULT_GREETING_HTML);
  });

  test("renders a custom greeting when provided", () => {
    const html = renderEmptyState({ greeting: "Welcome back, friend." });
    expect(html).toContain("Welcome back, friend.");
    expect(html).not.toContain(DEFAULT_GREETING_HTML);
  });

  test("uses title-medium on mobile and title-large on desktop for the greeting", () => {
    const html = renderEmptyState();
    expect(html).toContain("text-title-medium");
    expect(html).toContain("text-title-large");
  });
});

describe("ChatEmptyState — avatar slot", () => {
  test("renders avatarSlot when supplied", () => {
    const html = renderEmptyState({
      avatarSlot: <div data-testid="avatar">AVATAR_NODE</div>,
    });
    expect(html).toContain("AVATAR_NODE");
  });

  test("omits avatar markup when avatarSlot is not supplied", () => {
    const html = renderEmptyState();
    expect(html).not.toContain("AVATAR_NODE");
    expect(html).not.toContain('data-testid="avatar"');
  });
});

describe("ChatEmptyState — layout", () => {
  test("renders at natural height (no flex-1 or overflow) so the parent handles centering", () => {
    // ChatEmptyState must not own vertical centering or overflow — that
    // responsibility lives on ChatBody's outer container, which centers the
    // greeting + composer + starters as one group (LUM-1566).
    const html = renderEmptyState({ avatarSlot: <div>avatar</div> });
    expect(html).not.toContain("flex-1");
    expect(html).not.toContain("overflow-y-auto");
    expect(html).not.toContain("[justify-content:safe_center]");
  });
});
