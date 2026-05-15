import type { MetricInput, MetricResult } from "../../../src/lib/metrics";

const EXPECTED_DATE = "March 14";

export default function scoreTimelineRecall(input: MetricInput): MetricResult {
  const assistantText = input.transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content)
    .join("\n");
  const passed = new RegExp("\\bMarch\\s+14\\b", "i").test(assistantText);
  return {
    name: "timeline-recall-date-mentioned",
    score: passed ? 1 : 0,
    passed,
    reason: passed
      ? `Assistant recovered the expected date (${EXPECTED_DATE}).`
      : `Assistant did not recover the expected date (${EXPECTED_DATE}).`,
    metadata: { expectedDate: EXPECTED_DATE },
  };
}
