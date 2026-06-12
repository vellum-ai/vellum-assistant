import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";

/**
 * Checks that the deck was delivered as a PDF. Coherence/persuasiveness and
 * layout-shift checks on the rendered slides require asset inspection,
 * which is stubbed pending the Evals CRM decision.
 */
export default async function scorePdfDelivered(
  input: MetricInput,
): Promise<MetricResult> {
  const transcript = await readTranscript(input.runId);
  const assistantText = transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content)
    .join("\n");
  const score = /\.pdf\b|\bPDF\b/.test(assistantText) ? 1 : 0;
  return {
    name: "pdf-delivered",
    score,
    reason:
      score === 1
        ? "Assistant referenced delivering a PDF."
        : "No PDF deliverable referenced in assistant output.",
  };
}
