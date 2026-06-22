import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";

const CRITERIA: Array<{ name: string; pattern: RegExp }> = [
  {
    name: "oauth-connection-handled",
    pattern: /\b(oauth|connect(ed|ing)?|authoriz(e|ed|ation)|sign in)\b/i,
  },
  {
    name: "confirms-newsletter-archival",
    pattern:
      /newsletters?[\s\S]{0,200}\b(archive|archiving|ok(ay)? to|confirm|should i)\b|\b(archive|archiving)\b[\s\S]{0,200}newsletters?/i,
  },
  {
    name: "keeps-four-emails",
    pattern:
      /\b(4|four)\b[\s\S]{0,80}\b(left|remain|kept|keeping|in (the|your) inbox)\b/i,
  },
];

/**
 * Transcript-text proxy for the declutter outcome. True final-inbox-state
 * verification requires inspecting the mocked Gmail API state, which is
 * stubbed pending the Evals CRM decision (see ../assets/STUB.md).
 */
export default async function scoreTriageOutcome(
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
    name: "triage-outcome",
    score: passed / CRITERIA.length,
    reason: `${passed}/${CRITERIA.length} declutter criteria detected in assistant output.`,
    metadata: { results },
  };
}
