import type { MetricContext, MetricResult } from "../../../src/lib/metrics";

export default async function scoreAssistantCost(
  context: MetricContext,
): Promise<MetricResult> {
  const usage = await context.readUsage();
  const totalCostUsd = usage.totalCostUsd ?? 0;
  return {
    name: "assistant-cost-usd",
    score: -totalCostUsd,
    reason:
      usage.totalCostUsd === undefined
        ? "Assistant cost unavailable from current usage artifacts; scored as 0 until egress metering records priced usage."
        : `Assistant cost was $${totalCostUsd.toFixed(6)}.`,
    metadata: { ...usage },
  };
}
