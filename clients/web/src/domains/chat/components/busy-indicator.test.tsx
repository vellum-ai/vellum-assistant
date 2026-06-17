/**
 * Tests for `BusyIndicator`.
 *
 * The dot is a bare `<span>`, whose default `display: inline` makes the
 * CSS box model ignore `width`/`height`. Inside a flex parent the dot is
 * blockified and sizes correctly, but standalone (outside a flex parent)
 * it would collapse to 0×0 and never paint. The `inline-block` class
 * guarantees the dot lays out at its declared size regardless of its
 * parent's layout. Uses happy-dom via the bun:test preload configured in
 * `web/bunfig.toml`.
 */

import { afterEach, describe, expect, test } from "bun:test";

import { cleanup, render } from "@testing-library/react";

import { BusyIndicator } from "@/domains/chat/components/busy-indicator";

afterEach(() => {
  cleanup();
});

describe("BusyIndicator", () => {
  test("is block-level so its size applies outside a flex parent", () => {
    /**
     * Tests that the dot is block-level and carries its declared size,
     * so it paints even when its parent is not a flex container.
     */

    // GIVEN a 6px busy indicator rendered with no flex parent
    const { container } = render(<BusyIndicator size={6} />);

    // WHEN we read the rendered dot element
    const dot = container.firstElementChild as HTMLElement;

    // THEN it is block-level so width/height are not ignored
    expect(dot.className).toContain("inline-block");

    // AND it lays out at the requested size
    expect(dot.style.width).toBe("6px");
    expect(dot.style.height).toBe("6px");
  });

  test("uses the shared busy-pulse keyframe", () => {
    /**
     * Tests that the dot keeps the shared pulse class so its animation
     * matches every other busy affordance in the app.
     */

    // GIVEN a default busy indicator
    const { container } = render(<BusyIndicator size={8} />);

    // WHEN we read the rendered dot element
    const dot = container.firstElementChild as HTMLElement;

    // THEN it carries the shared busy-indicator pulse class
    expect(dot.className).toContain("busy-indicator");
  });
});
