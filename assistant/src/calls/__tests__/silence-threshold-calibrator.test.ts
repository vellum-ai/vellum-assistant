import { describe, expect, test } from "bun:test";

import {
  CALIBRATED_MAX_THRESHOLD_MS,
  CALIBRATED_MIN_THRESHOLD_MS,
  SilenceThresholdCalibrator,
} from "../silence-threshold-calibrator.js";

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("SilenceThresholdCalibrator", () => {
  // ── Default before enough samples ──────────────────────────────────

  test("returns default threshold before MIN_SAMPLES are collected", () => {
    const cal = new SilenceThresholdCalibrator(800);
    // 0 samples — still default
    expect(cal.calibrate()).toBe(800);

    for (let i = 0; i < 4; i++) {
      cal.addSample(300);
    }
    // 4 samples — still default (need 5)
    expect(cal.calibrate()).toBe(800);
  });

  test("sampleCount tracks observations", () => {
    const cal = new SilenceThresholdCalibrator(800);
    expect(cal.sampleCount).toBe(0);
    cal.addSample(200);
    cal.addSample(400);
    expect(cal.sampleCount).toBe(2);
  });

  // ── p75 calibration ────────────────────────────────────────────────

  test("calibrates to p75 of observed pauses once enough samples arrive", () => {
    const cal = new SilenceThresholdCalibrator(800);
    // 5 samples: [200, 300, 400, 500, 600] sorted → p75 is the 4th value = 500
    const samples = [400, 200, 600, 500, 300];
    for (const s of samples) {
      cal.addSample(s);
    }
    // sorted: [200, 300, 400, 500, 600]
    // ceil(5 * 0.75) - 1 = ceil(3.75) - 1 = 4 - 1 = 3 → index 3 → 500
    expect(cal.calibrate()).toBe(500);
  });

  test("calibrates correctly for a uniform pause pattern", () => {
    const cal = new SilenceThresholdCalibrator(800);
    // 10 equal samples of 600ms
    for (let i = 0; i < 10; i++) {
      cal.addSample(600);
    }
    expect(cal.calibrate()).toBe(600);
  });

  // ── Bounds ─────────────────────────────────────────────────────────

  test("clamps to CALIBRATED_MIN_THRESHOLD_MS when pauses are very short", () => {
    const cal = new SilenceThresholdCalibrator(800);
    // Very short pauses (user speaks in rapid bursts) → p75 would be ~100ms,
    // but the floor prevents going below the minimum.
    for (let i = 0; i < 10; i++) {
      cal.addSample(50);
    }
    expect(cal.calibrate()).toBe(CALIBRATED_MIN_THRESHOLD_MS);
  });

  test("clamps to CALIBRATED_MAX_THRESHOLD_MS when pauses are very long", () => {
    const cal = new SilenceThresholdCalibrator(800);
    // Very long pauses → p75 would be 2000ms, but the ceiling applies.
    for (let i = 0; i < 10; i++) {
      cal.addSample(2000);
    }
    expect(cal.calibrate()).toBe(CALIBRATED_MAX_THRESHOLD_MS);
  });

  // ── More samples refine the estimate ──────────────────────────────

  test("calibrated value updates as more samples arrive", () => {
    const cal = new SilenceThresholdCalibrator(800);
    // First 5 samples: all 300ms → calibrates to 300ms
    for (let i = 0; i < 5; i++) {
      cal.addSample(300);
    }
    const first = cal.calibrate();
    expect(first).toBe(CALIBRATED_MIN_THRESHOLD_MS); // 300 < min → clamped

    // 5 more samples of 800ms push the p75 up
    for (let i = 0; i < 5; i++) {
      cal.addSample(800);
    }
    const refined = cal.calibrate();
    expect(refined).toBeGreaterThan(first);
  });
});
