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
 *   1. Estimate is recorded for a `(provider, model)` pair via
 *      `handleUsage` (the record side still threads the provider-echoed
 *      model through `recordEstimate`).
 *   2. A subsequent `estimatePromptTokens` lookup picks up the learned
 *      correction via the per-provider aggregate key `(provider, "")`.
 *      Lookup always uses the aggregate — model-specific keys are only
 *      read as a fallback inside `getCorrection`.
 *
 * Since the `modelId` lookup option has been removed from the public
 * token-estimator API, the lookup side always converges to the aggregate.
 * `recordEstimate` still updates both the specific `(provider, model)`
 * key AND the `(provider, "")` aggregate on every sample, so the
 * aggregate stays accurate even as per-model data accumulates.
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

  test("subsequent estimate picks up the aggregate-key correction", () => {
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
    });
    expect(preSend).toBeGreaterThan(0);

    // Baseline: no correction recorded yet.
    expect(getCorrection("anthropic", "")).toBe(1.0);

    // 2. Provider returns ground truth (simulating `handleUsage`, which
    //    still records under (provider, event.model) and folds into the
    //    aggregate). Simulate a systematic 30% underestimate.
    const groundTruth = Math.ceil(preSend * 1.3);
    recordEstimate(
      getCalibrationProviderKey(provider),
      model,
      preSend,
      groundTruth,
    );

    // 3. Lookup under the aggregate key now returns the learned ratio.
    expect(getCorrection("anthropic", "")).toBeCloseTo(1.3, 3);

    // And the corrected estimate moves toward the ground truth.
    const corrected = estimatePromptTokens(history, "system", {
      providerName: getCalibrationProviderKey(provider),
    });
    // With correction factor ≈1.3, corrected estimate is within 1 token of
    // the ground truth (Math.ceil rounding).
    expect(corrected).toBeGreaterThan(preSend);
    expect(Math.abs(corrected - groundTruth)).toBeLessThanOrEqual(1);
  });

  test("record with model writes both the specific and aggregate keys", () => {
    // Simulate a preflight site that records against (anthropic, sonnet).
    // `recordEstimate` also folds the sample into the `(anthropic, "")`
    // aggregate so aggregate-key callers see the correction.
    const provider: Provider = {
      name: "anthropic",
      async sendMessage() {
        throw new Error("not used");
      },
    };
    const history = largeHistory();

    const preSend = estimatePromptTokens(history, "system", {
      providerName: getCalibrationProviderKey(provider),
    });
    const groundTruth = Math.ceil(preSend * 1.25);

    recordEstimate(
      getCalibrationProviderKey(provider),
      "claude-sonnet-4-5",
      preSend,
      groundTruth,
    );

    // A subsequent lookup via the token-estimator uses the per-provider
    // aggregate (the only key the public API reads).
    const correctedAggregate = estimatePromptTokens(history, "system", {
      providerName: getCalibrationProviderKey(provider),
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
    // Aggregate under the canonical upstream key is also populated.
    expect(getCorrection("anthropic", "")).toBeCloseTo(1.2, 3);
    // And under the bare wrapper name stays at the default, because NOTHING
    // was recorded under "openrouter".
    expect(getCorrection("openrouter", "")).toBe(1.0);

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
    });
    const groundTruth = Math.ceil(preSend * 1.3);

    for (let i = 0; i < 5; i++) {
      recordEstimate("anthropic", model, preSend, groundTruth);
    }

    const finalCorrection = getCorrection("anthropic", "");
    // EWMA with alpha=0.2 on constant 1.3 stays at 1.3 from the first sample
    // onward (all deltas are 0 after the initial snap). `precision=3` gives
    // us ~0.0005 tolerance which covers the Math.ceil rounding noise.
    expect(finalCorrection).toBeCloseTo(1.3, 3);

    const corrected = estimatePromptTokens(history, "system", {
      providerName: "anthropic",
    });
    // Corrected should be very close to the ground truth (within 1 token
    // because of the Math.ceil rounding at the end of estimatePromptTokens).
    expect(Math.abs(corrected - groundTruth)).toBeLessThanOrEqual(1);
  });
});
