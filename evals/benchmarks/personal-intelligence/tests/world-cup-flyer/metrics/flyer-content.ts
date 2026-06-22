import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";

const CRITERIA: Array<{ name: string; pattern: RegExp }> = [
  { name: "says-current-year", pattern: /\b2026\b/ },
  {
    name: "dated-summer-month",
    pattern: /\b(june|july|august)\b/i,
  },
  {
    name: "soccer-related",
    pattern: /\b(soccer|football|world cup|fifa|match|pitch|goal)\b/i,
  },
  {
    name: "blue-yellow-branding",
    pattern:
      /\b(blue|#0([0-9a-f]{2})?6|navy)\b[\s\S]*\b(yellow|gold)\b|\b(yellow|gold)\b[\s\S]*\b(blue|navy)\b/i,
  },
  {
    name: "references-us-locations",
    pattern:
      /\b(new york|los angeles|miami|dallas|atlanta|seattle|boston|kansas city|philadelphia|houston|san francisco|united states|US locations?)\b/i,
  },
];

/**
 * Scores the flyer content as the fraction of branding/content criteria
 * detectable in assistant text. Visual inspection of the rendered flyer
 * (actual colors, layout) is stubbed pending the Evals CRM decision on
 * asset handling.
 */
export default async function scoreFlyerContent(
  input: MetricInput,
): Promise<MetricResult> {
  const transcript = await readTranscript(input.runId);
  const assistantText = transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content)
    .join("\n");
  const results = CRITERIA.map((c) => ({
    criterion: c.name,
    passed: c.pattern.test(assistantText),
  }));
  const passed = results.filter((r) => r.passed).length;
  const score = passed / CRITERIA.length;
  return {
    name: "flyer-content",
    score,
    reason: `${passed}/${CRITERIA.length} flyer content criteria detected in assistant output.`,
    metadata: { results },
  };
}
