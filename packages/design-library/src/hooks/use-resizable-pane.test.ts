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
  migrateLegacySize,
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

describe("migrateLegacySize", () => {
  // The master-detail drawer's real numbers.
  const bounds = { minSize: 400, reserveForRest: 328 };
  const convert = (leftWidth: number, containerWidth: number) =>
    containerWidth - leftWidth - 8;

  test("converts a split that still fits", () => {
    expect(
      migrateLegacySize({
        stored: 700,
        containerSize: 1500,
        convert,
        ...bounds,
      }),
    ).toBe(792);
  });

  test("a split restored in a narrower container cannot persist below the minimum", () => {
    // 1000 - 700 - 8 = 292, under the 400px minimum. The migrated number is
    // written to storage, so an unclamped result would keep a width the pane
    // can never take and would recur on every reload.
    expect(
      migrateLegacySize({
        stored: 700,
        containerSize: 1000,
        convert,
        ...bounds,
      }),
    ).toBe(400);
  });

  test("a split restored in a narrower container cannot persist above the maximum", () => {
    // 1000 - 100 - 8 = 892, past the 672 the container leaves once the other
    // pane's minimum is reserved.
    expect(
      migrateLegacySize({
        stored: 100,
        containerSize: 1000,
        convert,
        ...bounds,
      }),
    ).toBe(672);
  });

  test("an absolute cap is honoured too", () => {
    expect(
      migrateLegacySize({
        stored: 100,
        containerSize: 2000,
        convert,
        minSize: 220,
        maxSize: 400,
        reserveForRest: 0,
      }),
    ).toBe(400);
  });

  test("a conversion that cannot produce a number is refused", () => {
    // Returning null leaves the legacy entry in place for a later attempt
    // rather than writing a broken value over it.
    expect(
      migrateLegacySize({
        stored: 700,
        containerSize: 1000,
        convert: () => Number.NaN,
        ...bounds,
      }),
    ).toBeNull();
  });

  test("rounds, so storage and aria-valuenow cannot disagree", () => {
    expect(
      migrateLegacySize({
        stored: 700,
        containerSize: 1522.36,
        convert,
        ...bounds,
      }),
    ).toBe(814);
  });
});
