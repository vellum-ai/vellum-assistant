/**
 * Corrected compaction target for reactive context-overflow recovery.
 *
 * When the provider rejects a request as context-too-large, the rejection
 * reveals the *actual* token count it measured (e.g. "242201 tokens > 200000").
 * The local estimator that gated the call may have significantly under-counted,
 * so compacting to the nominal preflight budget would still overshoot the
 * provider's real limit and re-reject. Scaling the preflight budget down by the
 * observed estimator error yields a target that, once the estimator re-measures
 * the reduced history, lands under the provider's true ceiling.
 */

/** The compaction target plus the estimator-error context used to derive it. */
export interface CorrectedOverflowTarget {
  /**
   * Token budget the reducer should compact below. Equal to `preflightBudget`
   * when the estimator did not under-count, and lower otherwise.
   */
  targetTokens: number;
  /**
   * The provider-actual / estimator ratio when the estimator under-counted
   * (> 1), otherwise `null`. Exposed so callers can log the adjustment without
   * recomputing it.
   */
  estimationErrorRatio: number | null;
}

/**
 * Compute the compaction target for an overflow rejection, lowering the
 * preflight budget in proportion to how badly the estimator under-counted.
 *
 * @param preflightBudget The nominal target the estimator gates against.
 * @param actualTokens    Provider-reported token count from the rejection, or
 *                        `null` when it could not be parsed.
 * @param estimatedTokens The estimator's count for the same history at overflow.
 */
export function computeCorrectedOverflowTarget(params: {
  preflightBudget: number;
  actualTokens: number | null;
  estimatedTokens: number;
}): CorrectedOverflowTarget {
  const { preflightBudget, actualTokens, estimatedTokens } = params;
  if (actualTokens != null && actualTokens > 0 && estimatedTokens > 0) {
    const estimationErrorRatio = actualTokens / estimatedTokens;
    if (estimationErrorRatio > 1.0) {
      return {
        targetTokens: Math.floor(preflightBudget / estimationErrorRatio),
        estimationErrorRatio,
      };
    }
  }
  return { targetTokens: preflightBudget, estimationErrorRatio: null };
}
