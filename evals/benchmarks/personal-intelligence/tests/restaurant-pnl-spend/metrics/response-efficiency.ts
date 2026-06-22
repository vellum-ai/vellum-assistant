import {
  readAssistantEvents,
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";
import { buildTranscriptView } from "../../../../../src/lib/transcript-view";

/**
 * Target number of assistant responses for an ideal run. The question is a
 * single ask with a single correct answer, so the agent should resolve it in
 * one reply; every extra response is a round-trip it should not have needed.
 */
const RESPONSE_BASELINE = 1;

/**
 * Counts the assistant's responses by folding the event stream back into whole
 * messages. The Vellum stream lands one transcript turn per
 * `assistant_text_delta`, so a single streamed answer spans many fragment
 * turns; `buildTranscriptView` collapses consecutive deltas into one message
 * (splitting only on simulator turns), so this counts semantic replies rather
 * than stream chunks.
 */
async function countAssistantResponses(runId: string): Promise<number> {
  const [turns, events] = await Promise.all([
    readTranscript(runId),
    readAssistantEvents(runId),
  ]);
  return buildTranscriptView(turns, events).filter(
    (item) => item.role === "assistant",
  ).length;
}

/**
 * Scores how efficiently the assistant answered, baselined to a single
 * response. A run that answers in one reply earns full marks; past the
 * baseline the score decays as the inverse ratio `min(1, baseline / responses)`
 * — 1→100%, 2→50%, 3→33%, 4→25% — matching the `assistant-cost` curve so the
 * two efficiency signals compose on the same 0-1 axis and keep a wide, legible
 * range instead of collapsing every chatty run to a flat 0%. A run that never
 * responded has no efficiency to credit and scores 0.
 */
export default async function scoreResponseEfficiency(
  input: MetricInput,
): Promise<MetricResult> {
  const responses = await countAssistantResponses(input.runId);

  if (responses <= 0) {
    return {
      name: "response-efficiency",
      score: 0,
      reason: "Assistant produced no response.",
      metadata: { responses, baseline: RESPONSE_BASELINE },
    };
  }

  const score = Math.min(1, RESPONSE_BASELINE / responses);
  const reason =
    responses <= RESPONSE_BASELINE
      ? `Answered in ${responses} response (baseline ${RESPONSE_BASELINE}).`
      : `Took ${responses} responses against a baseline of ${RESPONSE_BASELINE}.`;

  return {
    name: "response-efficiency",
    score,
    reason,
    metadata: { responses, baseline: RESPONSE_BASELINE },
  };
}
