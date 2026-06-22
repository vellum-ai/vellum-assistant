import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";

const EXPECTED_OPERATIONS = 3;

/**
 * Counts arithmetic demonstrations (e.g. "12 + 7 = 19") in assistant text as
 * a proxy for the assistant running calculator operations. Screenshot
 * evidence is not yet machine-checked — visual verification is stubbed
 * pending the Evals CRM decision on asset handling.
 */
export default async function scoreOperationsDemonstrated(
  input: MetricInput,
): Promise<MetricResult> {
  const transcript = await readTranscript(input.runId);
  const assistantText = transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content)
    .join("\n");
  const operations =
    assistantText.match(
      /\d+(?:\.\d+)?\s*[+\-×x*÷/]\s*\d+(?:\.\d+)?\s*=\s*-?\d+(?:\.\d+)?/g,
    ) ?? [];
  const score = Math.min(operations.length / EXPECTED_OPERATIONS, 1);
  return {
    name: "operations-demonstrated",
    score,
    reason: `Found ${operations.length} demonstrated calculator operation(s) (expected ~${EXPECTED_OPERATIONS}).`,
    metadata: { operations },
  };
}
