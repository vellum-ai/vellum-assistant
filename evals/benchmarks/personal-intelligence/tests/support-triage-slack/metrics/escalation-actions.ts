import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";

const CRITERIA: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "customer-issue-pr",
    pattern:
      /\b(pull request|PR)\b[\s\S]{0,200}\b(issue|bug)\b|\b(issue|bug)\b[\s\S]{0,200}\b(pull request|PR)\b/i,
  },
  {
    name: "feature-request-linear-ticket",
    pattern:
      /\blinear\b[\s\S]{0,200}\b(ticket|issue)\b|\b(feature request|FR)\b[\s\S]{0,200}\blinear\b/i,
  },
  {
    name: "non-issues-not-escalated",
    pattern:
      /\b(no (action|escalation)|doesn'?t (need|require)|skipp?(ed|ing)|ignor(ed|ing))\b/i,
  },
];

/**
 * Transcript-text proxy for triage correctness. Verifying the actual PR and
 * Linear ticket against the mocked Slack events requires the webhook
 * fixtures, which are stubbed pending the Evals CRM decision (see
 * ../assets/STUB.md).
 */
export default async function scoreEscalationActions(
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
    name: "escalation-actions",
    score: passed / CRITERIA.length,
    reason: `${passed}/${CRITERIA.length} triage escalation criteria detected in assistant output.`,
    metadata: { results },
  };
}
