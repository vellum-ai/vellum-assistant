/**
 * Tests for the chat pull-to-refresh hook.
 *
 * The repo's runner (bun:test) has no DOM environment. The hook itself
 * is a thin wiring layer over a few pure helpers — this file targets
 * those helpers directly. Each test maps to one of the acceptance
 * criteria in the PR plan.
 */

import { describe, expect, test } from "bun:test";

import {
  PULL_ELIGIBLE_BOTTOM_DISTANCE_PX,
  PULL_THRESHOLD_PX,
  canStartPull,
  classifyPull,
  computePullExtent,
  shouldFireThresholdHaptic,
} from "@/domains/chat/transcript/use-pull-to-refresh.js";

describe("computePullExtent (gesture direction — single source of truth)", () => {
  // The reverse PTR on a column-reverse transcript is INVERTED from a
  // standard PTR: at the visual bottom, the user pulls UP (toward the
  // top of the screen) to refresh — not down. clientY decreases when
  // the finger moves up, so positive pull extent = startY - currentY.

  test("finger moved up from start → positive pull extent (the actual gesture)", () => {
    expect(computePullExtent({ startY: 500, currentY: 440 })).toBe(60);
  });

  test("finger moved up far → larger positive extent", () => {
    expect(computePullExtent({ startY: 500, currentY: 380 })).toBe(120);
  });

  test("finger moved down from start → negative extent (wrong direction)", () => {
    expect(computePullExtent({ startY: 500, currentY: 540 })).toBe(-40);
  });

  test("finger stationary → zero extent", () => {
    expect(computePullExtent({ startY: 500, currentY: 500 })).toBe(0);
  });
});

describe("classifyPull", () => {
  test("at bottom, partial pull → pulling with fractional progress", () => {
    expect(classifyPull({ scrollTop: 0, dragDistance: 30 })).toEqual({
      phase: "pulling",
      progress: 30 / PULL_THRESHOLD_PX,
      atThreshold: false,
    });
  });

  test("at bottom, past threshold → pulling, progress clamped to 1, atThreshold true", () => {
    expect(classifyPull({ scrollTop: 0, dragDistance: 80 })).toEqual({
      phase: "pulling",
      progress: 1,
      atThreshold: true,
    });
  });

  test("scrolled away from bottom → ineligible regardless of drag", () => {
    expect(classifyPull({ scrollTop: -120, dragDistance: 80 })).toEqual({
      phase: "ineligible",
      progress: 0,
      atThreshold: false,
    });
  });

  test("finger moved down (negative pull extent, wrong direction) → ineligible", () => {
    // dragDistance is the pull extent: positive means the finger moved
    // upward from start (a real pull on a reverse PTR). A negative
    // value means the finger moved downward — that's the user starting
    // to scroll back through history, not a refresh request.
    expect(classifyPull({ scrollTop: 0, dragDistance: -10 })).toEqual({
      phase: "ineligible",
      progress: 0,
      atThreshold: false,
    });
  });

  test("just inside the eligibility window with positive drag → pulling", () => {
    expect(
      classifyPull({
        scrollTop: -PULL_ELIGIBLE_BOTTOM_DISTANCE_PX,
        dragDistance: 20,
      }),
    ).toMatchObject({ phase: "pulling" });
  });

  test("one pixel past the eligibility window → ineligible", () => {
    expect(
      classifyPull({
        scrollTop: -(PULL_ELIGIBLE_BOTTOM_DISTANCE_PX + 1),
        dragDistance: 20,
      }),
    ).toMatchObject({ phase: "ineligible" });
  });

  test("exactly at threshold → atThreshold true, progress 1", () => {
    expect(
      classifyPull({ scrollTop: 0, dragDistance: PULL_THRESHOLD_PX }),
    ).toEqual({ phase: "pulling", progress: 1, atThreshold: true });
  });
});

describe("shouldFireThresholdHaptic", () => {
  test("fires once when threshold is first crossed", () => {
    expect(
      shouldFireThresholdHaptic({
        atThreshold: true,
        hasFiredThisDrag: false,
      }),
    ).toBe(true);
  });

  test("does not fire if already fired this drag (re-cross is silent)", () => {
    expect(
      shouldFireThresholdHaptic({
        atThreshold: true,
        hasFiredThisDrag: true,
      }),
    ).toBe(false);
  });

  test("does not fire below threshold", () => {
    expect(
      shouldFireThresholdHaptic({
        atThreshold: false,
        hasFiredThisDrag: false,
      }),
    ).toBe(false);
  });
});

describe("canStartPull (refresh-in-flight + at-bottom guards)", () => {
  test("at bottom, not refreshing → can start", () => {
    expect(canStartPull({ isRefreshing: false, scrollTop: 0 })).toBe(true);
  });

  test("refresh in flight → cannot start (no flapping)", () => {
    expect(canStartPull({ isRefreshing: true, scrollTop: 0 })).toBe(false);
  });

  test("not at bottom → cannot start (gesture is dead while reading history)", () => {
    expect(
      canStartPull({ isRefreshing: false, scrollTop: -200 }),
    ).toBe(false);
  });

  test("just inside bottom eligibility window → can start", () => {
    expect(
      canStartPull({
        isRefreshing: false,
        scrollTop: -PULL_ELIGIBLE_BOTTOM_DISTANCE_PX,
      }),
    ).toBe(true);
  });
});
