import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";
import { LARGEST_SPEND_CATEGORY } from "../constants";

export default async function scoreLargestCategoryFound(
  input: MetricInput,
): Promise<MetricResult> {
  const transcript = await readTranscript(input.runId);
  const assistantText = transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content)
    .join("\n");
  const score = new RegExp(`\\b${LARGEST_SPEND_CATEGORY}\\b`, "i").test(
    assistantText,
  )
    ? 1
    : 0;
  return {
    name: "largest-category-found",
    score,
    reason:
      score === 1
        ? `Assistant identified the expected largest spend category (${LARGEST_SPEND_CATEGORY}).`
        : `Assistant did not identify the expected largest spend category (${LARGEST_SPEND_CATEGORY}).`,
    metadata: { expectedCategory: LARGEST_SPEND_CATEGORY },
  };
}
