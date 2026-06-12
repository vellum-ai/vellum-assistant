import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";

const EXPECTED_TOP_OPTIONS = 5;

/**
 * Checks that the assistant returned a ranked list of at least five priced
 * options. Verifying that the top 5 are the *cheapest matching* options
 * requires the Expedia mock fixture, which is stubbed pending the Evals CRM
 * decision (see ../assets/STUB.md).
 */
export default async function scoreRankedOptions(
  input: MetricInput,
): Promise<MetricResult> {
  const transcript = await readTranscript(input.runId);
  const assistantText = transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content)
    .join("\n");
  const prices = assistantText.match(/\$\s?\d{2,5}(?:[.,]\d{2})?/g) ?? [];
  const mentionsStarAlliance = /star alliance/i.test(assistantText);
  const pricedOptionsScore = Math.min(prices.length / EXPECTED_TOP_OPTIONS, 1);
  const score = mentionsStarAlliance ? pricedOptionsScore : 0;
  return {
    name: "ranked-options",
    score,
    reason: `Found ${prices.length} priced option(s); Star Alliance ${mentionsStarAlliance ? "" : "not "}referenced.`,
    metadata: { priceCount: prices.length, mentionsStarAlliance },
  };
}
