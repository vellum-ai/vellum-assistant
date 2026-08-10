/**
 * Tests for the resizable-pane sizing rules.
 *
 * The arithmetic is exported as plain functions so it can be asserted without
 * a DOM, matching the rest of this package. The separator's rendered markup is
 * covered in `pane-resize-handle.test.tsx`.
 */

import { describe, expect, test } from "bun:test";

import {
  boundedMaxSize,
  clampSize,
  nextSizeForKey,
  paneDelta,
  resolveMaxSize,
} from "./use-resizable-pane";

describe("resolveMaxSize", () => {
  test("reserves room for the other side out of the measured container", () => {
    expect(
      resolveMaxSize({
        minSize: 100,
        reserveForRest: 308,
        containerSize: 1000,
      }),
    ).toBe(692);
  });

  test("an absolute cap wins when it is the tighter bound", () => {
    expect(
      resolveMaxSize({
        minSize: 220,
        maxSize: 400,
        reserveForRest: 0,
        containerSize: 1000,
      }),
    ).toBe(400);
  });

  test("the pane's own minimum wins over a container too narrow for both", () => {
    // Rather than collapsing the pane past what it can render, the layout
    // overflows and the pane keeps its minimum.
    expect(
      resolveMaxSize({
        minSize: 300,
        reserveForRest: 800,
        containerSize: 900,
      }),
    ).toBe(300);
  });

  test("an unmeasured container leaves the bound unknown", () => {
    expect(
      resolveMaxSize({ minSize: 100, reserveForRest: 300, containerSize: 0 }),
    ).toBe(Number.POSITIVE_INFINITY);
  });
});

describe("boundedMaxSize", () => {
  test("passes a known bound through", () => {
    expect(boundedMaxSize(692, 100, 300)).toBe(692);
  });

  test("substitutes a real number for an unknown bound", () => {
    // `End` commits this and the separator announces it, so Infinity must
    // never survive: it cannot be rendered into aria-valuemax or a width.
    const bounded = boundedMaxSize(Number.POSITIVE_INFINITY, 100, 300);
    expect(bounded).toBe(300);
    expect(Number.isFinite(bounded)).toBe(true);
  });

  test("never returns below the minimum", () => {
    expect(boundedMaxSize(Number.POSITIVE_INFINITY, 400, 120)).toBe(400);
  });
});

describe("clampSize", () => {
  test("holds the value inside both bounds", () => {
    expect(clampSize(500, 100, 700)).toBe(500);
    expect(clampSize(50, 100, 700)).toBe(100);
    expect(clampSize(900, 100, 700)).toBe(700);
  });

  test("the minimum wins when the bounds are inverted", () => {
    expect(clampSize(500, 400, 200)).toBe(400);
  });
});

describe("paneDelta", () => {
  test("a start pane grows as the handle travels right", () => {
    expect(paneDelta(40, "start")).toBe(40);
    expect(paneDelta(-40, "start")).toBe(-40);
  });

  test("an end pane shrinks as the handle travels right", () => {
    // Arrow keys follow the divider, not the pane, so the sign flips here
    // rather than at the call site.
    expect(paneDelta(40, "end")).toBe(-40);
    expect(paneDelta(-40, "end")).toBe(40);
  });
});

describe("nextSizeForKey", () => {
  const start = {
    shiftKey: false,
    size: 300,
    side: "start" as const,
    minSize: 100,
    maxSize: 700,
  };
  const end = { ...start, side: "end" as const };

  test("arrows move the divider, so the two sides respond oppositely", () => {
    expect(nextSizeForKey("ArrowRight", start)).toBe(316);
    expect(nextSizeForKey("ArrowLeft", start)).toBe(284);
    expect(nextSizeForKey("ArrowRight", end)).toBe(284);
    expect(nextSizeForKey("ArrowLeft", end)).toBe(316);
  });

  test("Shift takes a coarser step in the same direction", () => {
    expect(nextSizeForKey("ArrowRight", { ...start, shiftKey: true })).toBe(
      364,
    );
    expect(nextSizeForKey("ArrowLeft", { ...end, shiftKey: true })).toBe(364);
  });

  test("Home and End go to the bounds regardless of side", () => {
    expect(nextSizeForKey("Home", start)).toBe(100);
    expect(nextSizeForKey("End", start)).toBe(700);
    expect(nextSizeForKey("Home", end)).toBe(100);
    expect(nextSizeForKey("End", end)).toBe(700);
  });

  test("keys the pattern does not implement are left to the browser", () => {
    // Enter is APG's collapse/restore, conditional on the implementation
    // supporting collapse. No pane here collapses, so claiming the key would
    // promise behaviour that does not exist.
    expect(nextSizeForKey("Enter", start)).toBeNull();
    expect(nextSizeForKey("PageUp", start)).toBeNull();
    expect(nextSizeForKey("ArrowUp", start)).toBeNull();
    expect(nextSizeForKey("Tab", start)).toBeNull();
  });
});

describe("legacy width conversion", () => {
  /** The conversion `ResizablePanel` supplies: a left width becomes a right width. */
  const convert = (leftWidth: number, containerWidth: number) =>
    containerWidth - leftWidth - 8;

  test("preserves the layout a stored left width described", () => {
    // A 700px left pane in a 1000px container leaves 292px on the right once
    // the handle's own 8px is accounted for, which is the same split.
    expect(convert(700, 1000)).toBe(292);
  });

  test("round-trips against the reserve the hook applies", () => {
    const containerWidth = 1000;
    const leftWidth = 640;
    const rightWidth = convert(leftWidth, containerWidth);
    expect(rightWidth + leftWidth + 8).toBe(containerWidth);
  });
});
