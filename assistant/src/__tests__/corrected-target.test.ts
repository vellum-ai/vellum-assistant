import { describe, expect, test } from "bun:test";

import { computeCorrectedOverflowTarget } from "../plugins/defaults/compaction/corrected-target.js";

describe("computeCorrectedOverflowTarget", () => {
  test("lowers the target proportionally when the estimator under-counted", () => {
    /**
     * When the provider's actual token count exceeds the estimator's count,
     * the target is scaled down by the estimation-error ratio so a re-estimate
     * of the reduced history lands under the provider's real ceiling.
     */
    // GIVEN a preflight budget and an estimator that under-counted (185k vs 242k actual)
    const preflightBudget = 162_000;
    const actualTokens = 242_000;
    const estimatedTokens = 185_000;

    // WHEN computing the corrected target
    const result = computeCorrectedOverflowTarget({
      preflightBudget,
      actualTokens,
      estimatedTokens,
    });

    // THEN the target is the budget divided by the error ratio
    const expectedRatio = actualTokens / estimatedTokens;
    expect(result.targetTokens).toBe(
      Math.floor(preflightBudget / expectedRatio),
    );
    // AND the ratio is surfaced for logging
    expect(result.estimationErrorRatio).toBeCloseTo(expectedRatio, 10);
    // AND the corrected target is below the nominal budget
    expect(result.targetTokens).toBeLessThan(preflightBudget);
  });

  test("returns the preflight budget unchanged when the estimator did not under-count", () => {
    /**
     * If the estimator matched or over-counted the provider, no correction is
     * applied and the nominal preflight budget is the target.
     */
    // GIVEN an actual count at or below the estimate
    const preflightBudget = 162_000;

    // WHEN computing the corrected target
    const result = computeCorrectedOverflowTarget({
      preflightBudget,
      actualTokens: 180_000,
      estimatedTokens: 185_000,
    });

    // THEN the target is the unchanged preflight budget and no ratio is reported
    expect(result.targetTokens).toBe(preflightBudget);
    expect(result.estimationErrorRatio).toBeNull();
  });

  test("falls back to the preflight budget when the actual count is unavailable", () => {
    /**
     * Proxy-rewrapped or unparseable rejections yield a null actual count; the
     * correction is skipped rather than guessed.
     */
    // GIVEN a null actual token count
    const preflightBudget = 162_000;

    // WHEN computing the corrected target
    const result = computeCorrectedOverflowTarget({
      preflightBudget,
      actualTokens: null,
      estimatedTokens: 185_000,
    });

    // THEN the nominal budget is used with no ratio
    expect(result.targetTokens).toBe(preflightBudget);
    expect(result.estimationErrorRatio).toBeNull();
  });

  test("falls back to the preflight budget when the estimate is zero", () => {
    /**
     * A zero estimate would make the ratio undefined; guard against it.
     */
    // GIVEN a zero estimate
    const preflightBudget = 162_000;

    // WHEN computing the corrected target
    const result = computeCorrectedOverflowTarget({
      preflightBudget,
      actualTokens: 242_000,
      estimatedTokens: 0,
    });

    // THEN the nominal budget is used with no ratio
    expect(result.targetTokens).toBe(preflightBudget);
    expect(result.estimationErrorRatio).toBeNull();
  });
});
