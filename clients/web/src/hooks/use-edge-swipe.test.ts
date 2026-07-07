import { describe, expect, test } from "bun:test";

import {
  activationZonePx,
  commitThresholdPx,
  computeDrawerOffset,
  computeVisualOffset,
  decideDirection,
  isCommitted,
  isVerticalEscape,
} from "@/hooks/use-edge-swipe";

describe("activationZonePx", () => {
  test("spans the left half of the viewport", () => {
    expect(activationZonePx(390)).toBe(195);
    expect(activationZonePx(1000)).toBe(500);
  });
});

describe("computeDrawerOffset", () => {
  test("anchors the panel's right edge to the finger's absolute position", () => {
    // At x, a full-width panel resting closed at -viewportWidth is revealed to
    // width x, so its translateX is x - viewportWidth.
    expect(computeDrawerOffset(150, 390)).toBe(-240);
    expect(computeDrawerOffset(390, 390)).toBe(0);
  });

  test("never exceeds fully open (clamps at 0)", () => {
    expect(computeDrawerOffset(500, 390)).toBe(0);
  });
});

describe("commitThresholdPx", () => {
  test("uses the fixed px ceiling on wide viewports", () => {
    // 0.3 * 1000 = 300, capped at the 100px ceiling.
    expect(commitThresholdPx(1000)).toBe(100);
  });

  test("uses the viewport fraction on narrow viewports", () => {
    // 0.3 * 200 = 60, below the 100px ceiling.
    expect(commitThresholdPx(200)).toBe(60);
  });

  test("returns the smaller of the two near the crossover", () => {
    // 0.3 * 333 = 99.9, just under the ceiling.
    expect(commitThresholdPx(333)).toBeCloseTo(99.9, 5);
  });
});

describe("isVerticalEscape", () => {
  test("is false when horizontal travel dominates", () => {
    // 50 <= 100 * 0.7 = 70.
    expect(isVerticalEscape(100, 50)).toBe(false);
  });

  test("is true when vertical travel exceeds the ratio", () => {
    // 80 > 100 * 0.7 = 70.
    expect(isVerticalEscape(100, 80)).toBe(true);
  });

  test("is true for pure vertical travel", () => {
    expect(isVerticalEscape(0, 10)).toBe(true);
  });

  test("uses magnitudes, ignoring sign", () => {
    expect(isVerticalEscape(-100, -80)).toBe(true);
    expect(isVerticalEscape(-100, -50)).toBe(false);
  });
});

describe("decideDirection", () => {
  test("is pending inside the deadzone on both axes", () => {
    expect(decideDirection(5, 5)).toBe("pending");
    expect(decideDirection(9, -9)).toBe("pending");
  });

  test("leaves the deadzone exactly at the 10px boundary", () => {
    // |dx| = 10 is not < DEADZONE_PX, so the gesture is decided here.
    expect(decideDirection(10, 0)).toBe("confirm");
  });

  test("confirms a rightward swipe past the deadzone", () => {
    expect(decideDirection(20, 5)).toBe("confirm");
  });

  test("cancels a leftward (wrong-direction) swipe", () => {
    expect(decideDirection(-20, 5)).toBe("cancel");
  });

  test("cancels when vertical travel dominates", () => {
    // 20 > 20 * 0.7 = 14.
    expect(decideDirection(20, 20)).toBe("cancel");
  });

  test("cancels a pure vertical scroll", () => {
    expect(decideDirection(0, 20)).toBe("cancel");
  });

  test("checks vertical escape before horizontal direction", () => {
    // Leftward AND vertical — still classified as cancel.
    expect(decideDirection(-5, 20)).toBe("cancel");
  });
});

describe("computeVisualOffset", () => {
  test("tracks the finger 1:1 up to the threshold", () => {
    expect(computeVisualOffset(50, 100)).toBe(50);
    expect(computeVisualOffset(100, 100)).toBe(100);
  });

  test("damps travel past the threshold", () => {
    // 100 + (150 - 100) * 0.3 = 115.
    expect(computeVisualOffset(150, 100)).toBe(115);
  });

  test("never returns more than threshold + damped overdrag", () => {
    const offset = computeVisualOffset(1000, 100);
    expect(offset).toBe(100 + 900 * 0.3);
    expect(offset).toBeLessThan(1000);
  });
});

describe("isCommitted", () => {
  test("commits at or beyond the threshold", () => {
    expect(isCommitted(100, 100)).toBe(true);
    expect(isCommitted(150, 100)).toBe(true);
  });

  test("does not commit below the threshold", () => {
    expect(isCommitted(99, 100)).toBe(false);
  });
});
