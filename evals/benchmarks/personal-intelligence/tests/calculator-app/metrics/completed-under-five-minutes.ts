import {
  readRunMetadata,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";

const LIMIT_MS = 5 * 60 * 1000;

export default async function scoreCompletedUnderFiveMinutes(
  input: MetricInput,
): Promise<MetricResult> {
  const metadata = await readRunMetadata(input.runId);
  const startedAt = metadata?.startedAt;
  const completedAt = metadata?.completedAt;
  if (!startedAt || !completedAt) {
    return {
      name: "completed-under-five-minutes",
      score: 0,
      reason: "Run timing unavailable — missing startedAt/completedAt.",
    };
  }
  const elapsedMs = Date.parse(completedAt) - Date.parse(startedAt);
  const score = elapsedMs > 0 && elapsedMs < LIMIT_MS ? 1 : 0;
  return {
    name: "completed-under-five-minutes",
    score,
    reason: `Run took ${(elapsedMs / 60000).toFixed(2)} minutes (limit 5).`,
    metadata: { elapsedMs, limitMs: LIMIT_MS },
  };
}
