import { describe, expect, test } from "bun:test";

import { computeDecayedIntensity, computeFidelityLevel } from "./decay.js";
import type { EmotionalCharge } from "./types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeCharge(overrides: Partial<EmotionalCharge> = {}): EmotionalCharge {
  return {
    valence: 0.5,
    intensity: 0.8,
    decayCurve: "linear",
    decayRate: 0.05,
    originalIntensity: 0.8,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// computeDecayedIntensity
// ---------------------------------------------------------------------------

describe("computeDecayedIntensity", () => {
  test("returns current intensity when no time has elapsed", () => {
    const charge = makeCharge({ intensity: 0.8 });
    expect(computeDecayedIntensity(charge, 0)).toBe(0.8);
  });

  test("returns current intensity for negative elapsed time", () => {
    const charge = makeCharge({ intensity: 0.8 });
    expect(computeDecayedIntensity(charge, -5)).toBe(0.8);
  });

  // --- Linear ---

  test("linear: decays at constant rate per day", () => {
    const charge = makeCharge({
      decayCurve: "linear",
      decayRate: 0.1,
      originalIntensity: 1.0,
    });
    // After 5 days: 1.0 - 0.1 × 5 = 0.5
    expect(computeDecayedIntensity(charge, 5)).toBeCloseTo(0.5, 5);
  });

  test("linear: floors at 0", () => {
    const charge = makeCharge({
      decayCurve: "linear",
      decayRate: 0.1,
      originalIntensity: 0.5,
    });
    // After 10 days: 0.5 - 0.1 × 10 = -0.5 → clamped to 0
    expect(computeDecayedIntensity(charge, 10)).toBe(0);
  });

  test("linear: fully decayed after enough time", () => {
    const charge = makeCharge({
      decayCurve: "linear",
      decayRate: 0.05,
      originalIntensity: 0.8,
    });
    // After 20 days: 0.8 - 0.05 × 20 = -0.2 → 0
    expect(computeDecayedIntensity(charge, 20)).toBe(0);
  });

  // --- Logarithmic ---

  test("logarithmic: sharp initial drop, long tail", () => {
    const charge = makeCharge({
      decayCurve: "logarithmic",
      decayRate: 0.5,
      originalIntensity: 1.0,
    });
    const at1 = computeDecayedIntensity(charge, 1);
    const at10 = computeDecayedIntensity(charge, 10);
    const at100 = computeDecayedIntensity(charge, 100);

    // Sharp drop initially
    expect(at1).toBeLessThan(1.0);
    // But long tail — never reaches 0
    expect(at10).toBeGreaterThan(0);
    expect(at100).toBeGreaterThan(0);
    // Monotonic decay
    expect(at1).toBeGreaterThan(at10);
    expect(at10).toBeGreaterThan(at100);
  });

  test("logarithmic: formula I₀ / (1 + rate × ln(1 + t))", () => {
    const charge = makeCharge({
      decayCurve: "logarithmic",
      decayRate: 0.5,
      originalIntensity: 0.8,
    });
    const days = 10;
    const expected = 0.8 / (1 + 0.5 * Math.log(1 + days));
    expect(computeDecayedIntensity(charge, days)).toBeCloseTo(expected, 10);
  });

  // --- Transformative ---

  test("transformative: decays but floors at 20% of original", () => {
    const charge = makeCharge({
      decayCurve: "transformative",
      decayRate: 0.1,
      originalIntensity: 1.0,
    });
    const atInfinity = computeDecayedIntensity(charge, 10000);
    // Floor is 20% of original = 0.2
    expect(atInfinity).toBeCloseTo(0.2, 5);
  });

  test("transformative: exponential decay above the floor", () => {
    const charge = makeCharge({
      decayCurve: "transformative",
      decayRate: 0.1,
      originalIntensity: 1.0,
    });
    const at5 = computeDecayedIntensity(charge, 5);
    const at10 = computeDecayedIntensity(charge, 10);

    expect(at5).toBeGreaterThan(at10);
    // at5: max(0.2, 1.0 × e^(-0.1×5)) = max(0.2, 0.607) = 0.607
    expect(at5).toBeCloseTo(Math.exp(-0.5), 3);
    // at10: max(0.2, 1.0 × e^(-0.1×10)) = max(0.2, 0.368) = 0.368
    expect(at10).toBeCloseTo(Math.exp(-1), 3);
  });

  // --- Permanent ---

  test("permanent: no decay at all", () => {
    const charge = makeCharge({
      decayCurve: "permanent",
      decayRate: 0.5, // ignored
      originalIntensity: 0.9,
      intensity: 0.9,
    });
    // At elapsed=0, returns charge.intensity (the early return)
    expect(computeDecayedIntensity(charge, 0)).toBe(0.9);
    // For any elapsed > 0, returns originalIntensity (permanent never decays)
    expect(computeDecayedIntensity(charge, 100)).toBe(0.9);
    expect(computeDecayedIntensity(charge, 10000)).toBe(0.9);
  });
});

// ---------------------------------------------------------------------------
// computeFidelityLevel
// ---------------------------------------------------------------------------

describe("computeFidelityLevel", () => {
  test("stays vivid within the first 7 days", () => {
    expect(computeFidelityLevel("vivid", 3, 0.5)).toBe("vivid");
    expect(computeFidelityLevel("vivid", 6, 0.5)).toBe("vivid");
  });

  test("downgrades vivid → clear after 7 days", () => {
    expect(computeFidelityLevel("vivid", 8, 0.5)).toBe("clear");
  });

  test("downgrades clear → faded after 37 days (7 vivid + 30 clear)", () => {
    expect(computeFidelityLevel("vivid", 38, 0.5)).toBe("faded");
  });

  test("downgrades faded → gist after 127 days (7+30+90)", () => {
    expect(computeFidelityLevel("vivid", 130, 0.5)).toBe("gist");
  });

  test("never auto-downgrades to gone", () => {
    // Even after 500 days, should cap at gist (gone is consolidation's job)
    expect(computeFidelityLevel("vivid", 500, 0.5)).toBe("gist");
    expect(computeFidelityLevel("gist", 5000, 0.5)).toBe("gist");
  });

  test("never upgrades fidelity", () => {
    // If currently at "faded", should stay at "faded" even if time says "vivid"
    expect(computeFidelityLevel("faded", 1, 0.5)).toBe("faded");
    expect(computeFidelityLevel("clear", 1, 0.5)).toBe("clear");
    expect(computeFidelityLevel("gist", 1, 0.5)).toBe("gist");
    expect(computeFidelityLevel("gone", 1, 0.5)).toBe("gone");
  });

  test("high significance (0.8+) doubles thresholds", () => {
    // vivid threshold at sig 0.8: 7 × 2 = 14 days
    expect(computeFidelityLevel("vivid", 10, 0.8)).toBe("vivid");
    expect(computeFidelityLevel("vivid", 15, 0.8)).toBe("clear");

    // vivid+clear at sig 0.8: (7+30) × 2 = 74 days
    expect(computeFidelityLevel("vivid", 70, 0.8)).toBe("clear");
    expect(computeFidelityLevel("vivid", 75, 0.8)).toBe("faded");
  });

  test("very high significance (0.9+) triples thresholds", () => {
    // vivid threshold at sig 0.9: 7 × 3 = 21 days
    expect(computeFidelityLevel("vivid", 15, 0.9)).toBe("vivid");
    expect(computeFidelityLevel("vivid", 22, 0.9)).toBe("clear");

    // vivid+clear at sig 0.9: (7+30) × 3 = 111 days
    expect(computeFidelityLevel("vivid", 100, 0.9)).toBe("clear");
    expect(computeFidelityLevel("vivid", 112, 0.9)).toBe("faded");
  });

  test("low significance uses normal thresholds", () => {
    // No resistance factor for sig < 0.8
    expect(computeFidelityLevel("vivid", 8, 0.3)).toBe("clear");
    expect(computeFidelityLevel("vivid", 8, 0.79)).toBe("clear");
  });
});
