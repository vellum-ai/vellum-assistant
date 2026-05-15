import type { MetricContext, MetricResult } from "../../../src/lib/metrics";

const EXPECTED_DATE = "March 14";

export default async function scoreDateMentioned(
  context: MetricContext,
): Promise<MetricResult> {
  const transcript = await context.readTranscript();
  const assistantText = transcript
    .filter((turn) => turn.role === "assistant" && turn.phase === "eval")
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
        ? `Assistant recovered the expected date (${EXPECTED_DATE}).`
        : `Assistant did not recover the expected date (${EXPECTED_DATE}).`,
    metadata: { expectedDate: EXPECTED_DATE },
  };
}
