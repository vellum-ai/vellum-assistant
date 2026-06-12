import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";

const STUMBLE_PATTERNS = [
  /that didn'?t work/i,
  /let me try (something|another|again)/i,
  /trying a different approach/i,
  /hmm,? that (failed|didn'?t)/i,
  /oops/i,
];

export default async function scoreNoStumbling(
  input: MetricInput,
): Promise<MetricResult> {
  const transcript = await readTranscript(input.runId);
  const assistantTurns = transcript.filter(
    (turn) => turn.role === "assistant",
  );
  if (assistantTurns.length === 0) {
    return {
      name: "no-stumbling",
      score: 0,
      reason: "No assistant responses to evaluate.",
      metadata: { matchedPatterns: [] },
    };
  }
  const assistantText = assistantTurns.map((turn) => turn.content).join("\n");
  const stumbles = STUMBLE_PATTERNS.filter((p) => p.test(assistantText));
  const score = stumbles.length === 0 ? 1 : 0;
  return {
    name: "no-stumbling",
    score,
    reason:
      score === 1
        ? "Assistant never narrated stumbling or retries."
        : `Assistant narrated stumbling (${stumbles.length} pattern(s) matched).`,
    metadata: { matchedPatterns: stumbles.map(String) },
  };
}
