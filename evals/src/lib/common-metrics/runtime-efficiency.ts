import {
  readAssistantEvents,
  readTranscript,
  type MetricInput,
  type MetricResult,
  type MetricScorer,
} from "../metrics";

/**
 * The agent's conversation wall-clock: from the first simulator message
 * landing to the agent's last output, in ms.
 *
 * Measured from the transcript/event timestamps rather than the run's
 * `startedAt`/`completedAt`, because that wall-clock also covers container
 * hatch (~1 min for the Vellum stack) and post-conversation grading — harness
 * overhead the agent has no control over. The span here starts when the first
 * question reaches the agent and ends at its last streamed event (falling back
 * to the last assistant transcript turn for species like Hermes whose
 * single-shot events carry no per-event timestamp), so it reflects how long
 * the agent itself took to answer.
 *
 * Returns `undefined` when the run lacks the timestamps to measure a span
 * (no simulator message, or no assistant activity at all).
 */
export async function conversationMs(
  runId: string,
): Promise<number | undefined> {
  const [turns, events] = await Promise.all([
    readTranscript(runId),
    readAssistantEvents(runId),
  ]);

  const simulatorStarts = turns
    .filter((turn) => turn.role === "simulator")
    .map((turn) => Date.parse(turn.emittedAt))
    .filter((ms) => !Number.isNaN(ms));
  if (simulatorStarts.length === 0) return undefined;
  const start = Math.min(...simulatorStarts);

  const assistantEnds = [
    ...events
      .map((event) => event.emittedAt)
      .filter((at): at is string => typeof at === "string")
      .map((at) => Date.parse(at)),
    ...turns
      .filter((turn) => turn.role === "assistant")
      .map((turn) => Date.parse(turn.emittedAt)),
  ].filter((ms) => !Number.isNaN(ms));
  if (assistantEnds.length === 0) return undefined;
  const end = Math.max(...assistantEnds);

  return Math.max(0, end - start);
}

export interface RuntimeEfficiencyOptions {
  /**
   * Conversation wall-clock that earns full marks, in ms. A run that resolves
   * within this span scores 1; slower runs decay from there. Each test picks a
   * baseline matching how long its task should reasonably take.
   */
  baselineMs: number;
  /** Metric name surfaced in the report. Defaults to `"runtime-efficiency"`. */
  name?: string;
}

/**
 * Build a metric that scores how quickly the agent answered, baselined to a
 * caller-supplied conversation wall-clock. A run that finishes within the
 * baseline earns full marks; past it the score decays as the inverse ratio
 * `min(1, baseline / elapsed)` — the same hyperbolic curve as `assistant-cost`
 * and `response-efficiency`, so the efficiency signals compose on one 0-1 axis.
 * The curve only approaches 0 asymptotically (twice the baseline still scores
 * 0.5, six times still 0.17), so any run that answered at all keeps a non-zero
 * score; a flat 0 is reserved for a run with no measurable conversation span to
 * credit at all.
 *
 * Shared across tests so a single time-based metric is parameterized per test
 * rather than reimplemented: see `restaurant-pnl-spend` and `calculator-app`.
 */
export function makeRuntimeEfficiencyMetric(
  options: RuntimeEfficiencyOptions,
): MetricScorer {
  const { baselineMs } = options;
  const name = options.name ?? "runtime-efficiency";

  return async function scoreRuntimeEfficiency(
    input: MetricInput,
  ): Promise<MetricResult> {
    const elapsed = await conversationMs(input.runId);

    if (elapsed === undefined || elapsed <= 0) {
      return {
        name,
        score: 0,
        reason: "No measurable conversation runtime.",
        metadata: { elapsedMs: elapsed ?? null, baselineMs },
      };
    }

    const score = Math.min(1, baselineMs / elapsed);
    const elapsedMin = (elapsed / 60_000).toFixed(1);
    const baselineMin = baselineMs / 60_000;
    const reason =
      elapsed <= baselineMs
        ? `Answered in ${elapsedMin} min (baseline ${baselineMin} min).`
        : `Took ${elapsedMin} min against a baseline of ${baselineMin} min.`;

    return {
      name,
      score,
      reason,
      metadata: { elapsedMs: elapsed, baselineMs },
    };
  };
}
