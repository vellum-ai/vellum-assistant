import {
  hasAssistantResponse,
  readRunMetadata,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";

const LIMIT_MS = 5 * 60 * 1000;

/**
 * Metrics run before the runner writes the final `completedAt`, so the end
 * timestamp falls back to scoring time — an upper bound that only adds the
 * few milliseconds between the last assistant turn and metric execution.
 */
export default async function scoreCompletedUnderFiveMinutes(
  input: MetricInput,
): Promise<MetricResult> {
  if (!(await hasAssistantResponse(input.runId))) {
    return {
      name: "completed-under-five-minutes",
      score: 0,
      reason: "No assistant responses — the task never completed.",
    };
  }
  const metadata = await readRunMetadata(input.runId);
  const startedAt = metadata?.startedAt;
  if (!startedAt) {
    return {
      name: "completed-under-five-minutes",
      score: 0,
      reason: "Run timing unavailable — missing startedAt.",
    };
  }
  const endedAt = metadata?.completedAt ?? new Date().toISOString();
  const elapsedMs = Date.parse(endedAt) - Date.parse(startedAt);
  const score = elapsedMs > 0 && elapsedMs < LIMIT_MS ? 1 : 0;
  return {
    name: "completed-under-five-minutes",
    score,
    reason: `Run took ${(elapsedMs / 60000).toFixed(2)} minutes (limit 5).`,
    metadata: { elapsedMs, limitMs: LIMIT_MS },
  };
}
