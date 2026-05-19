import {
  readUsage,
  type MetricInput,
  type MetricResult,
} from "../../../src/lib/metrics";

/**
 * Cost is reported as a negative number so "higher score = better" — a
 * profile that spent less dollars has a less-negative cost score, which
 * sorts ahead of a profile that spent more.
 *
 * The score carries dollar units, not a 0-1 fraction, so this metric
 * opts into `unit: "raw"`. Without that, `report-html` would multiply
 * the value by 100 and render "$-0.001234" as "-0.12%", which is
 * meaningless. With `"raw"`, the report falls back to the plain number
 * formatter and keeps the dollar reading legible.
 */
export default async function scoreAssistantCost(
  input: MetricInput,
): Promise<MetricResult> {
  const usage = await readUsage(input.runId);
  const totalCostUsd = usage.totalCostUsd ?? 0;
  return {
    name: "assistant-cost-usd",
    score: -totalCostUsd,
    unit: "raw",
    reason:
      usage.totalCostUsd === undefined
        ? "Assistant cost unavailable from current usage artifacts; scored as 0 until egress metering records priced usage."
        : `Assistant cost was $${totalCostUsd.toFixed(6)}.`,
    metadata: { ...usage },
  };
}
