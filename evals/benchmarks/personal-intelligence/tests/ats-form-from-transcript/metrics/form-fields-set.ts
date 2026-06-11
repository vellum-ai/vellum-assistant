import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";

const EXPECTED_FIELDS = [
  /\bname\b/i,
  /\b(role|position|title)\b/i,
  /\b(experience|background|years)\b/i,
  /\b(salary|compensation|expectations?)\b/i,
];

/**
 * Transcript-text proxy for ATS form completion. Verifying field values on
 * the candidate details page requires the ATS mock and transcript fixture,
 * which are stubbed pending the Evals CRM decision (see ../assets/STUB.md).
 */
export default async function scoreFormFieldsSet(
  input: MetricInput,
): Promise<MetricResult> {
  const transcript = await readTranscript(input.runId);
  const assistantText = transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content)
    .join("\n");
  const filled = EXPECTED_FIELDS.filter((p) => p.test(assistantText));
  const score = filled.length / EXPECTED_FIELDS.length;
  return {
    name: "form-fields-set",
    score,
    reason: `${filled.length}/${EXPECTED_FIELDS.length} expected ATS field topics referenced in assistant output.`,
    metadata: { matchedFields: filled.map(String) },
  };
}
