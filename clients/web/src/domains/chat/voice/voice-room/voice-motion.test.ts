/**
 * Tests for `createAmplitudeSmoother` — the VU-meter ballistic behind the
 * listening waves. The contract that matters: fast attack / slow release
 * asymmetry, and frame-rate independence (same elapsed time → same value,
 * regardless of how many frames it was split across).
 */

import { describe, expect, test } from "bun:test";

import { createAmplitudeSmoother } from "@/domains/chat/voice/voice-room/voice-motion";

const BALLISTICS = { attackMs: 80, releaseMs: 350 };

describe("createAmplitudeSmoother", () => {
  test("one attack time constant reaches ~63% of a step target", () => {
    const smoother = createAmplitudeSmoother(BALLISTICS);
    const value = smoother.step(1, BALLISTICS.attackMs);
    expect(value).toBeCloseTo(1 - Math.exp(-1), 3);
  });

  test("release is slower than attack for the same elapsed time", () => {
    const rising = createAmplitudeSmoother(BALLISTICS);
    const risen = rising.step(1, 100);

    const falling = createAmplitudeSmoother(BALLISTICS);
    falling.step(1, 1_000_000); // effectively settle at 1
    const fallen = falling.step(0, 100);

    // In 100 ms the attack covers more of its gap (1 - risen below the target)
    // than the release covers of its own (fallen still near 1).
    expect(risen).toBeGreaterThan(1 - fallen);
  });

  test("frame-rate independent: many small steps equal one large step", () => {
    const fine = createAmplitudeSmoother(BALLISTICS);
    let fineValue = 0;
    for (let i = 0; i < 16; i++) {
      fineValue = fine.step(1, 1);
    }

    const coarse = createAmplitudeSmoother(BALLISTICS);
    const coarseValue = coarse.step(1, 16);

    expect(fineValue).toBeCloseTo(coarseValue, 6);
  });

  test("a non-positive dt leaves the value unchanged", () => {
    const smoother = createAmplitudeSmoother(BALLISTICS);
    const value = smoother.step(1, 50);
    expect(smoother.step(0, 0)).toBe(value);
    expect(smoother.step(0, -5)).toBe(value);
  });
});
