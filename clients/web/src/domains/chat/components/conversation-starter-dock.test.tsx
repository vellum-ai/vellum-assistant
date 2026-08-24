/**
 * Tests for the starters dock's reserved placeholder.
 *
 * The dock's whole job is that chips arrive without moving anything, and it
 * does that by holding a placeholder the size of the chips that will land in
 * it. That only works while the placeholder's border box and a real chip's
 * border box are built from the same classes, and they are not built by the
 * same code: the chip goes through the design library's `Button`, which
 * contributes classes of its own. The pin below is on that seam.
 */

import { afterEach, describe, expect, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";

import { ConversationStarterChip } from "@/domains/chat/components/conversation-starter-chip";
import { ConversationStarterDock } from "@/domains/chat/components/conversation-starter-dock";
import type { ConversationStarter } from "@/domains/chat/utils/conversation-starters";

const STARTER: ConversationStarter = {
  id: "starter-1",
  label: "Draft a plan for tomorrow morning",
  prompt: "Draft a plan",
  category: null,
  batch: 0,
};

/**
 * Classes that build a border box: its height floor, border, padding, corner,
 * and the type that sets its content height. Anything outside this set (a
 * background, a cursor, a transition) cannot change how tall the box is.
 */
const BOX_CLASS =
  /^(sm:)?(h-|min-h-|max-h-|p[xytblrse]?-|border([0-9-]*)?$|rounded|text-body|leading-|box-)/;

function boxClasses(element: Element | null | undefined): string[] {
  const raw = element?.getAttribute("class") ?? "";
  return raw
    .split(/\s+/)
    .filter((token) => token.length > 0 && BOX_CLASS.test(token))
    .sort();
}

afterEach(() => {
  cleanup();
});

describe("ConversationStarterDock reserved placeholder", () => {
  test("is built to the same border box as a real chip", () => {
    // The regression: `Button` sets a 1px border on its base and paints it
    // transparent for `ghost`, so a chip past its height floor (the two-line
    // case the dock reserves for) is 2px taller than a placeholder that only
    // copied the padding. Chips landing then pushed the dock open.
    const chip = render(
      <ConversationStarterChip label={STARTER.label} onSelect={() => {}} />,
    );
    const chipBox = boxClasses(chip.container.querySelector("button"));
    cleanup();

    const dock = render(
      <ConversationStarterDock starters={[]} isReserving onSelect={() => {}} />,
    );
    const placeholder = dock.container.querySelector(
      '[data-slot="conversation-starter-dock-reserve"] .grid > *',
    );

    expect(chipBox.length).toBeGreaterThan(0);
    expect(boxClasses(placeholder)).toEqual(chipBox);
  });

  test("reserves one placeholder per chip the grid will show", () => {
    const { container } = render(
      <ConversationStarterDock starters={[]} isReserving onSelect={() => {}} />,
    );

    const reserve = container.querySelector(
      '[data-slot="conversation-starter-dock-reserve"] .grid',
    );
    expect(reserve?.children.length).toBe(4);
  });

  test("the placeholder is hidden from assistive technology", () => {
    const { container } = render(
      <ConversationStarterDock starters={[]} isReserving onSelect={() => {}} />,
    );

    const reserve = container.querySelector(
      '[data-slot="conversation-starter-dock-reserve"]',
    );
    expect(reserve?.getAttribute("aria-hidden")).toBe("true");
    expect(reserve?.querySelector("button")).toBeNull();
  });

  test("draws nothing when it has neither chips nor a reserve", () => {
    const { container } = render(
      <ConversationStarterDock
        starters={[]}
        isReserving={false}
        onSelect={() => {}}
      />,
    );

    expect(container.innerHTML).toBe("");
  });

  test("keeps the reserve under chips that have landed", () => {
    const { container } = render(
      <ConversationStarterDock
        starters={[STARTER]}
        isReserving
        onSelect={() => {}}
      />,
    );

    expect(
      container.querySelector(
        '[data-slot="conversation-starter-dock-reserve"]',
      ),
    ).not.toBeNull();
    expect(
      container.querySelector(`[aria-label="Send: ${STARTER.label}"]`),
    ).not.toBeNull();
  });
});
