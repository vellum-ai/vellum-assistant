import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";

const CRITERIA: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "order-fulfillment-handled",
    pattern: /\b(order|fulfillment|shipping|tracking|deliver(y|ed))\b/i,
  },
  {
    name: "refund-handled",
    pattern: /\brefund(ed|s)?\b/i,
  },
  {
    name: "policy-cited",
    pattern: /\b(per|according to|based on|our)\b[\s\S]{0,40}\bpolic(y|ies)\b/i,
  },
];

/**
 * Transcript-text proxy for policy compliance. Validating each action
 * against the prefilled company policies requires the policy fixture, which
 * is stubbed pending the Evals CRM decision (see ../assets/STUB.md).
 */
export default async function scorePolicyHandling(
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
  return {
    name: "policy-handling",
    score: passed / CRITERIA.length,
    reason: `${passed}/${CRITERIA.length} policy-handling criteria detected in assistant output.`,
    metadata: { results },
  };
}
