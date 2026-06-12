import {
  readUsage,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";
import { scoreCostAgainstBaseline } from "../../../../../src/lib/cost-score";

/**
 * Target assistant spend for a good timeline-recall run, in USD. A run at or
 * under this baseline scores 100%; the score decays linearly to 0% at twice
 * the baseline. Tune this as the captured-cost picture firms up.
 */
const COST_BASELINE_USD = 0.02;

/**
 * Score the run's assistant cost as a 0-1 quality fraction measuring how far
 * the spend lands from `COST_BASELINE_USD` (see `scoreCostAgainstBaseline`).
 * Reporting cost on the 0-1 axis keeps it composable with quality metrics
 * like `date-mentioned` instead of injecting raw negative dollars into the
 * aggregate.
 */
export default async function scoreAssistantCost(
  input: MetricInput,
): Promise<MetricResult> {
  const usage = await readUsage(input.runId);
  const totalCostUsd = usage.totalCostUsd;

  if (totalCostUsd === undefined) {
    return {
      name: "assistant-cost-usd",
      score: 0,
      reason:
        "Assistant cost unavailable from current usage artifacts; scored as 0 until egress metering records priced usage.",
      metadata: { baselineUsd: COST_BASELINE_USD, ...usage },
    };
  }

  const score = scoreCostAgainstBaseline(totalCostUsd, COST_BASELINE_USD);
  return {
    name: "assistant-cost-usd",
    score,
    reason: `Assistant cost $${totalCostUsd.toFixed(6)} against a $${COST_BASELINE_USD.toFixed(
      2,
    )} baseline → ${(score * 100).toFixed(
      0,
    )}% (100% at or under the baseline, 0% at 2× the baseline).`,
    metadata: {
      baselineUsd: COST_BASELINE_USD,
      costUsd: totalCostUsd,
      ...usage,
    },
  };
}
