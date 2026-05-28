import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";
import { PEANUT_ALLERGY_DATE } from "../constants";

export default async function scoreDateMentioned(
  input: MetricInput,
): Promise<MetricResult> {
  const transcript = await readTranscript(input.runId);
  const assistantText = transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content)
    .join("\n");
  const score = new RegExp("\\bMarch\\s+14\\b", "i").test(assistantText)
    ? 1
    : 0;
  return {
    name: "date-mentioned",
    score,
    reason:
      score === 1
        ? `Assistant recovered the expected date (${PEANUT_ALLERGY_DATE}).`
        : `Assistant did not recover the expected date (${PEANUT_ALLERGY_DATE}).`,
    metadata: { expectedDate: PEANUT_ALLERGY_DATE },
  };
}
