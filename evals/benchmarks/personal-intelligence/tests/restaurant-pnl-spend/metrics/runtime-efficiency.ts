import {
  readAssistantEvents,
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";

/**
 * Target conversation wall-clock for an ideal run, in ms. A single P&L
 * question should be answered well inside ten minutes, so a run that resolves
 * it in that span or less earns full marks and slower runs decay from there.
 */
const RUNTIME_BASELINE_MS = 600_000;

/**
 * The agent's conversation wall-clock: from the first simulator message
 * landing to the agent's last output.
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
async function conversationMs(runId: string): Promise<number | undefined> {
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

/**
 * Scores how quickly the agent answered, baselined to a ten-minute
 * conversation. A run that finishes within the baseline earns full marks; past
 * it the score decays as the inverse ratio `min(1, baseline / elapsed)` — the
 * same hyperbolic curve as `assistant-cost` and `response-efficiency`, so the
 * efficiency signals compose on one 0-1 axis. The curve only approaches 0
 * asymptotically (a 20-minute run still scores 0.5, an hour 0.17), so any run
 * that answered at all keeps a non-zero score; a flat 0 is reserved for a run
 * with no measurable conversation span to credit at all.
 */
export default async function scoreRuntimeEfficiency(
  input: MetricInput,
): Promise<MetricResult> {
  const elapsed = await conversationMs(input.runId);

  if (elapsed === undefined || elapsed <= 0) {
    return {
      name: "runtime-efficiency",
      score: 0,
      reason: "No measurable conversation runtime.",
      metadata: { elapsedMs: elapsed ?? null, baselineMs: RUNTIME_BASELINE_MS },
    };
  }

  const score = Math.min(1, RUNTIME_BASELINE_MS / elapsed);
  const elapsedMin = (elapsed / 60_000).toFixed(1);
  const baselineMin = RUNTIME_BASELINE_MS / 60_000;
  const reason =
    elapsed <= RUNTIME_BASELINE_MS
      ? `Answered in ${elapsedMin} min (baseline ${baselineMin} min).`
      : `Took ${elapsedMin} min against a baseline of ${baselineMin} min.`;

  return {
    name: "runtime-efficiency",
    score,
    reason,
    metadata: { elapsedMs: elapsed, baselineMs: RUNTIME_BASELINE_MS },
  };
}
