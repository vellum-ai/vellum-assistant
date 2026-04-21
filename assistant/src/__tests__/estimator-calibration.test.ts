import { beforeEach, describe, expect, test } from "bun:test";

import {
  getCalibrationSnapshot,
  getCorrection,
  recordEstimate,
  resetCalibrations,
} from "../context/estimator-calibration.js";

describe("estimator calibration", () => {
  beforeEach(() => {
    resetCalibrations();
  });

  test("default correction is 1.0 for unseen (provider, model)", () => {
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBe(1.0);
    expect(getCorrection("openai", "gpt-5")).toBe(1.0);
  });

  test("first sample yields the exact ratio", () => {
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 130_000);
    const ratio = getCorrection("anthropic", "claude-sonnet-4-5");
    expect(ratio).toBeCloseTo(1.3, 5);
  });

  test("EWMA converges to the target ratio given consistent samples", () => {
    // Seed with a ratio far from the target so the first sample is off,
    // then hammer with consistent 1.3 samples and watch EWMA close the gap.
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 100_000);
    for (let i = 0; i < 20; i++) {
      recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 130_000);
    }
    const ratio = getCorrection("anthropic", "claude-sonnet-4-5");
    expect(ratio).toBeGreaterThan(1.25);
    expect(ratio).toBeLessThan(1.35);
  });

  test("ten consistent 1.3 samples land within 0.05 of 1.3", () => {
    for (let i = 0; i < 10; i++) {
      recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 130_000);
    }
    const ratio = getCorrection("anthropic", "claude-sonnet-4-5");
    expect(Math.abs(ratio - 1.3)).toBeLessThan(0.05);
  });

  test("values below MIN_SAMPLE_MAGNITUDE are ignored", () => {
    // Both below the floor
    recordEstimate("anthropic", "claude-sonnet-4-5", 200, 400);
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBe(1.0);

    // Estimated below the floor
    recordEstimate("anthropic", "claude-sonnet-4-5", 200, 100_000);
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBe(1.0);

    // Actual below the floor
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 200);
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBe(1.0);
  });

  test("ratios outside [1/3, 3] are discarded as outliers", () => {
    // 4x too high
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 400_000);
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBe(1.0);

    // 4x too low
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 25_000);
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBe(1.0);

    // Just above the 3x edge — still discarded
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 300_001);
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBe(1.0);

    // Exactly at the 3x edge — accepted (ratio === 3, not > 3)
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 300_000);
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBeCloseTo(3, 5);
  });

  test("resetCalibrations clears all state", () => {
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 130_000);
    recordEstimate("openai", "gpt-5", 100_000, 90_000);
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBeCloseTo(1.3);
    expect(getCorrection("openai", "gpt-5")).toBeCloseTo(0.9);

    resetCalibrations();
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBe(1.0);
    expect(getCorrection("openai", "gpt-5")).toBe(1.0);
    expect(getCalibrationSnapshot()).toHaveLength(0);
  });

  test("distinct (provider, model) keys are independent", () => {
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 130_000);
    recordEstimate("anthropic", "claude-opus-4-7", 100_000, 110_000);
    recordEstimate("openai", "gpt-5", 100_000, 90_000);
    recordEstimate("openai", "gpt-5", 100_000, 90_000);
    recordEstimate("openai", "gpt-5", 100_000, 90_000);

    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBeCloseTo(1.3, 5);
    expect(getCorrection("anthropic", "claude-opus-4-7")).toBeCloseTo(1.1, 5);
    // openai::gpt-5: after 3 EWMA steps of ratio 0.9, still exactly 0.9
    // because the first sample snaps to ratio and subsequent deltas are 0.
    expect(getCorrection("openai", "gpt-5")).toBeCloseTo(0.9, 5);

    // Model separation: ensure a sample to one (provider, model) pair does
    // not pollute another model under the same provider.
    expect(getCorrection("anthropic", "claude-opus-4-7")).not.toBe(
      getCorrection("anthropic", "claude-sonnet-4-5"),
    );
  });

  test("snapshot reports current calibrations", () => {
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 130_000);
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 130_000);
    recordEstimate("openai", "gpt-5", 100_000, 90_000);

    const snap = getCalibrationSnapshot();
    // Every non-empty-model sample also updates the per-provider aggregate
    // key (provider, ""). Two providers × {specific model, aggregate} = 4.
    expect(snap).toHaveLength(4);

    const anthropicEntry = snap.find(
      (e) => e.provider === "anthropic" && e.model === "claude-sonnet-4-5",
    );
    expect(anthropicEntry).toBeDefined();
    expect(anthropicEntry?.samples).toBe(2);
    expect(anthropicEntry?.ratio).toBeCloseTo(1.3, 5);

    const openaiEntry = snap.find(
      (e) => e.provider === "openai" && e.model === "gpt-5",
    );
    expect(openaiEntry).toBeDefined();
    expect(openaiEntry?.samples).toBe(1);
    expect(openaiEntry?.ratio).toBeCloseTo(0.9, 5);

    // Per-provider aggregates are present and track the specific samples.
    const anthropicAggregate = snap.find(
      (e) => e.provider === "anthropic" && e.model === "",
    );
    expect(anthropicAggregate?.samples).toBe(2);
    expect(anthropicAggregate?.ratio).toBeCloseTo(1.3, 5);

    const openaiAggregate = snap.find(
      (e) => e.provider === "openai" && e.model === "",
    );
    expect(openaiAggregate?.samples).toBe(1);
    expect(openaiAggregate?.ratio).toBeCloseTo(0.9, 5);
  });

  test("empty model string is treated as its own key (per-provider fallback)", () => {
    recordEstimate("anthropic", "", 100_000, 130_000);
    expect(getCorrection("anthropic", "")).toBeCloseTo(1.3, 5);
    // A specific model under the same provider is unaffected.
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBe(1.0);
  });

  test("recording with a specific model also updates the per-provider aggregate", () => {
    // The calibration writes `(provider, model)` and every caller of
    // `estimatePromptTokens` that cannot resolve a model falls back to
    // `(provider, "")`. Without the aggregate update, those callers would
    // stay at the 1.0 default forever, defeating the whole mechanism.
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 130_000);
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBeCloseTo(1.3, 5);
    expect(getCorrection("anthropic", "")).toBeCloseTo(1.3, 5);
    // A different provider is unaffected.
    expect(getCorrection("openai", "")).toBe(1.0);
  });

  test("the per-provider aggregate tracks a rolling EWMA across models", () => {
    // Samples across two models for one provider should each feed the
    // aggregate EWMA, so a generic lookup reflects recent activity from
    // any model on that provider.
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 120_000);
    recordEstimate("anthropic", "claude-opus-4-7", 100_000, 120_000);
    recordEstimate("anthropic", "claude-sonnet-4-5", 100_000, 120_000);
    recordEstimate("anthropic", "claude-opus-4-7", 100_000, 120_000);

    // After four consistent 1.2 samples (folded into both the model-specific
    // and the aggregate keys) the EWMA for each sits very close to 1.2.
    expect(getCorrection("anthropic", "")).toBeCloseTo(1.2, 1);
    expect(getCorrection("anthropic", "claude-sonnet-4-5")).toBeCloseTo(1.2, 1);
    expect(getCorrection("anthropic", "claude-opus-4-7")).toBeCloseTo(1.2, 1);
  });

  test("explicit empty-model recording does not double-count the aggregate", () => {
    // When a caller passes an empty model string (degenerate case), the
    // aggregate update path must not run — otherwise the sample would be
    // folded into the EWMA twice and the ratio would be wrong.
    recordEstimate("anthropic", "", 100_000, 120_000);
    // Exactly one sample applied.
    const snap = getCalibrationSnapshot().filter(
      (e) => e.provider === "anthropic" && e.model === "",
    );
    expect(snap).toHaveLength(1);
    expect(snap[0].samples).toBe(1);
    expect(snap[0].ratio).toBeCloseTo(1.2, 5);
  });
});
