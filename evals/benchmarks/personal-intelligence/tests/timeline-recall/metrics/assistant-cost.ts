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

  // A partial/missing cost figure can't be scored against the baseline: it
  // reflects only the requests we managed to price, so an under-baseline
  // subtotal would falsely award full marks while the unmetered traffic
  // (e.g. main-agent inference routed off the parsed host) is exactly what
  // would push spend over budget. Score those 0 and surface why.
  const unreliable =
    usage.costStatus === "partial" || usage.costStatus === "missing";
  if (totalCostUsd === undefined || unreliable) {
    const unpriced = usage.costDiagnostics?.length ?? 0;
    const reason =
      totalCostUsd === undefined
        ? "Assistant cost unavailable from current usage artifacts; scored as 0 until egress metering records priced usage."
        : `Assistant cost only partially metered (${unpriced} request${
            unpriced === 1 ? "" : "s"
          } unpriced); scored as 0 because a partial subtotal ($${totalCostUsd.toFixed(
            6,
          )}) can't be trusted against the baseline.`;
    return {
      name: "assistant-cost-usd",
      score: 0,
      reason,
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
