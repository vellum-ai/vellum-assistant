import { beforeEach, describe, expect, test } from "bun:test";

import {
  getCalibrationSnapshot,
  getCorrection,
  recordEstimate,
  resetCalibrations,
} from "../context/estimator-calibration.js";
import {
  estimatePromptTokens,
  getCalibrationProviderKey,
} from "../context/token-estimator.js";
import type { Message, Provider } from "../providers/types.js";

/**
 * Integration-style tests that exercise the full self-calibration loop end
 * to end:
 *   1. Estimate is recorded for a `(provider, model)` pair (simulating the
 *      pre-send path in `agent/loop.ts`).
 *   2. The provider returns a ground-truth `inputTokens` via a usage event
 *      (simulating the `handleUsage` path).
 *   3. A subsequent `estimatePromptTokens` call for the SAME `(provider,
 *      model)` picks up the learned correction.
 *
 * This is the scenario both Codex (P1) and Devin flagged: before the fix,
 * callers of `estimatePromptTokens` passed only `providerName` without
 * `modelId`, so the helper looked up `(provider, "")` — a key that was
 * never written. The result was that calibration was effectively a no-op
 * because the recorded key and the lookup key did not match.
 */
describe("estimator calibration — end-to-end recording → lookup", () => {
  beforeEach(() => {
    resetCalibrations();
  });

  /**
   * Build a representative message history with enough content to clear the
   * MIN_SAMPLE_MAGNITUDE floor (500 tokens). Each message repeats a block of
   * text large enough to make the heuristic estimator produce a substantial
   * token count so the calibration machinery actually runs.
   */
  function largeHistory(): Message[] {
    const body = "lorem ipsum dolor sit amet ".repeat(500);
    return [
      { role: "user", content: [{ type: "text", text: body }] },
      { role: "assistant", content: [{ type: "text", text: body }] },
      { role: "user", content: [{ type: "text", text: body }] },
    ];
  }

  test("subsequent estimate with the same modelId picks up the learned ratio", () => {
    const provider: Provider = {
      name: "anthropic",
      async sendMessage() {
        throw new Error("not used in this test");
      },
    };
    const model = "claude-sonnet-4-5";
    const history = largeHistory();

    // 1. Raw estimate (what agent/loop.ts computes pre-send).
    const preSend = estimatePromptTokens(history, "system", {
      providerName: getCalibrationProviderKey(provider),
      modelId: model,
    });
    expect(preSend).toBeGreaterThan(0);

    // Baseline: no correction recorded yet.
    expect(getCorrection("anthropic", model)).toBe(1.0);

    // 2. Provider returns ground truth (simulating `handleUsage`).
    // Simulate a systematic 30% underestimate (common for Anthropic where
    // the heuristic misses some xml-wrap overhead on tools/thinking).
    const groundTruth = Math.ceil(preSend * 1.3);
    recordEstimate(
      getCalibrationProviderKey(provider),
      model,
      preSend,
      groundTruth,
    );

    // 3. Lookup with the same key now returns the learned ratio. Math.ceil
    // on the ground truth introduces ~1/preSend of rounding noise in the
    // stored ratio, so precision=3 is tight enough to catch regressions
    // without false positives.
    expect(getCorrection("anthropic", model)).toBeCloseTo(1.3, 3);

    // And the corrected estimate moves toward the ground truth.
    const corrected = estimatePromptTokens(history, "system", {
      providerName: getCalibrationProviderKey(provider),
      modelId: model,
    });
    // With correction factor ≈1.3, corrected estimate is within 1 token of
    // the ground truth (Math.ceil rounding).
    expect(corrected).toBeGreaterThan(preSend);
    expect(Math.abs(corrected - groundTruth)).toBeLessThanOrEqual(1);
  });

  test("caller without a modelId still gets the per-provider aggregate correction", () => {
    // Simulate a preflight site that records against (anthropic, sonnet),
    // then a separate, early-init caller that has no modelId available.
    // Before the fix, the early-init caller looked up (anthropic, "") which
    // was never written — so it got 1.0 and the calibration was useless.
    // With the aggregate-update path, (anthropic, "") now tracks the
    // rolling per-provider average.
    const provider: Provider = {
      name: "anthropic",
      async sendMessage() {
        throw new Error("not used");
      },
    };
    const history = largeHistory();

    const preSend = estimatePromptTokens(history, "system", {
      providerName: getCalibrationProviderKey(provider),
      modelId: "claude-sonnet-4-5",
    });
    const groundTruth = Math.ceil(preSend * 1.25);

    recordEstimate(
      getCalibrationProviderKey(provider),
      "claude-sonnet-4-5",
      preSend,
      groundTruth,
    );

    // A subsequent lookup without a modelId (e.g. window-manager that
    // doesn't know the active model yet) uses the per-provider aggregate.
    const correctedAggregate = estimatePromptTokens(history, "system", {
      providerName: getCalibrationProviderKey(provider),
      // modelId intentionally omitted
    });
    // Aggregate ratio ≈ 1.25 (first sample snaps to exact ratio).
    expect(correctedAggregate).toBe(Math.ceil(preSend * 1.25));
  });

  test("wrapper provider (OpenRouter → Anthropic) uses the canonical key on both sides", () => {
    // This is the Devin scenario: OpenRouter wraps Anthropic. If the record
    // site used `name` ("openrouter") and the lookup site used
    // `tokenEstimationProvider` ("anthropic"), the data would be scattered
    // across mismatched keys and calibration would silently fail.
    // `getCalibrationProviderKey` gives us one source of truth.
    const openrouter: Provider = {
      name: "openrouter",
      tokenEstimationProvider: "anthropic",
      async sendMessage() {
        throw new Error("not used");
      },
    };
    const model = "anthropic/claude-sonnet-4-5";
    const history = largeHistory();

    // Pre-send estimate via the canonical key.
    const preSend = estimatePromptTokens(history, "system", {
      providerName: getCalibrationProviderKey(openrouter),
      modelId: model,
    });
    expect(preSend).toBeGreaterThan(0);

    // Provider returns ground truth. `handleUsage` uses the same helper
    // to pick the calibration key, so the record and lookup sides agree.
    const groundTruth = Math.ceil(preSend * 1.2);
    recordEstimate(
      getCalibrationProviderKey(openrouter),
      model,
      preSend,
      groundTruth,
    );

    // Lookup under "anthropic" — the canonical upstream key — returns the
    // ratio. See note above about precision=3.
    expect(getCorrection("anthropic", model)).toBeCloseTo(1.2, 3);
    // And under the bare wrapper name stays at the default, because NOTHING
    // was recorded under "openrouter".
    expect(getCorrection("openrouter", model)).toBe(1.0);

    // The snapshot reflects a single (provider, model) key + aggregate under
    // the canonical upstream key — never under the wrapper name.
    const keys = getCalibrationSnapshot().map(
      (e) => `${e.provider}::${e.model}`,
    );
    expect(keys).toContain(`anthropic::${model}`);
    expect(keys).toContain("anthropic::");
    expect(keys).not.toContain(`openrouter::${model}`);
  });

  test("a run of consistent samples pulls the estimate toward ground truth", () => {
    // The EWMA should converge quickly. After five consistent 1.3 samples
    // the correction should be within 1% of 1.3, and the corrected estimate
    // should be within 1% of the ground truth.
    const model = "claude-sonnet-4-5";
    const history = largeHistory();

    const preSend = estimatePromptTokens(history, "system", {
      providerName: "anthropic",
      modelId: model,
    });
    const groundTruth = Math.ceil(preSend * 1.3);

    for (let i = 0; i < 5; i++) {
      recordEstimate("anthropic", model, preSend, groundTruth);
    }

    const finalCorrection = getCorrection("anthropic", model);
    // EWMA with alpha=0.2 on constant 1.3 stays at 1.3 from the first sample
    // onward (all deltas are 0 after the initial snap). `precision=3` gives
    // us ~0.0005 tolerance which covers the Math.ceil rounding noise.
    expect(finalCorrection).toBeCloseTo(1.3, 3);

    const corrected = estimatePromptTokens(history, "system", {
      providerName: "anthropic",
      modelId: model,
    });
    // Corrected should be very close to the ground truth (within 1 token
    // because of the Math.ceil rounding at the end of estimatePromptTokens).
    expect(Math.abs(corrected - groundTruth)).toBeLessThanOrEqual(1);
  });
});
