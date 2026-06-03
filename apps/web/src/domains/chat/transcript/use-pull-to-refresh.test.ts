/**
 * Tests for the chat pull-to-refresh hook.
 *
 * The repo's runner (bun:test) has no DOM environment. The hook itself
 * is a thin wiring layer over a few pure helpers — this file targets
 * those helpers directly. Each test maps to one of the acceptance
 * criteria in the PR plan.
 *
 * The transcript uses plain `flex-col` (latest at the visual bottom),
 * so PTR follows the standard iOS pattern: pull DOWN at the bottom to
 * refresh. `distanceFromBottom = max(0, scrollHeight − clientHeight −
 * scrollTop)` is the eligibility metric.
 */

import { describe, expect, test } from "bun:test";

import {
  PULL_ELIGIBLE_BOTTOM_DISTANCE_PX,
  PULL_THRESHOLD_PX,
  canStartPull,
  classifyPull,
  computePullExtent,
  shouldFireThresholdHaptic,
} from "@/domains/chat/transcript/pull-to-refresh-utils";

/** Build a metrics fixture for a transcript where the visual bottom
 *  (max scrollTop) is at `scrollHeight − clientHeight = 1000`. Then
 *  `scrollTop = 1000` is at the bottom, `scrollTop = 0` is at the top. */
function atDistanceFromBottom(distance: number) {
  return { scrollTop: 1000 - distance, scrollHeight: 1800, clientHeight: 800 };
}

describe("computePullExtent (gesture direction — single source of truth)", () => {
  // In flex-col chat, PTR at the visual bottom is the standard iOS
  // gesture: the user pulls DOWN to refresh. clientY increases when
  // the finger moves down, so positive pull extent = currentY - startY.

  test("finger moved down from start → positive pull extent (the actual gesture)", () => {
    expect(computePullExtent({ startY: 500, currentY: 560 })).toBe(60);
  });

  test("finger moved down far → larger positive extent", () => {
    expect(computePullExtent({ startY: 500, currentY: 620 })).toBe(120);
  });

  test("finger moved up from start → negative extent (wrong direction)", () => {
    expect(computePullExtent({ startY: 500, currentY: 460 })).toBe(-40);
  });

  test("finger stationary → zero extent", () => {
    expect(computePullExtent({ startY: 500, currentY: 500 })).toBe(0);
  });
});

describe("classifyPull", () => {
  test("at bottom, partial pull → pulling with fractional progress", () => {
    expect(
      classifyPull({ ...atDistanceFromBottom(0), dragDistance: 30 }),
    ).toEqual({
      phase: "pulling",
      progress: 30 / PULL_THRESHOLD_PX,
      atThreshold: false,
    });
  });

  test("at bottom, past threshold → pulling, progress clamped to 1, atThreshold true", () => {
    expect(
      classifyPull({ ...atDistanceFromBottom(0), dragDistance: 80 }),
    ).toEqual({
      phase: "pulling",
      progress: 1,
      atThreshold: true,
    });
  });

  test("scrolled away from bottom → ineligible regardless of drag", () => {
    expect(
      classifyPull({ ...atDistanceFromBottom(120), dragDistance: 80 }),
    ).toEqual({
      phase: "ineligible",
      progress: 0,
      atThreshold: false,
    });
  });

  test("finger moved up (negative pull extent, wrong direction) → ineligible", () => {
    expect(
      classifyPull({ ...atDistanceFromBottom(0), dragDistance: -10 }),
    ).toEqual({
      phase: "ineligible",
      progress: 0,
      atThreshold: false,
    });
  });

  test("just inside the eligibility window with positive drag → pulling", () => {
    expect(
      classifyPull({
        ...atDistanceFromBottom(PULL_ELIGIBLE_BOTTOM_DISTANCE_PX),
        dragDistance: 20,
      }),
    ).toMatchObject({ phase: "pulling" });
  });

  test("one pixel past the eligibility window → ineligible", () => {
    expect(
      classifyPull({
        ...atDistanceFromBottom(PULL_ELIGIBLE_BOTTOM_DISTANCE_PX + 1),
        dragDistance: 20,
      }),
    ).toMatchObject({ phase: "ineligible" });
  });

  test("exactly at threshold → atThreshold true, progress 1", () => {
    expect(
      classifyPull({
        ...atDistanceFromBottom(0),
        dragDistance: PULL_THRESHOLD_PX,
      }),
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
    expect(
      canStartPull({ isRefreshing: false, ...atDistanceFromBottom(0) }),
    ).toBe(true);
  });

  test("refresh in flight → cannot start (no flapping)", () => {
    expect(
      canStartPull({ isRefreshing: true, ...atDistanceFromBottom(0) }),
    ).toBe(false);
  });

  test("not at bottom → cannot start (gesture is dead while reading history)", () => {
    expect(
      canStartPull({ isRefreshing: false, ...atDistanceFromBottom(200) }),
    ).toBe(false);
  });

  test("just inside bottom eligibility window → can start", () => {
    expect(
      canStartPull({
        isRefreshing: false,
        ...atDistanceFromBottom(PULL_ELIGIBLE_BOTTOM_DISTANCE_PX),
      }),
    ).toBe(true);
  });
});
