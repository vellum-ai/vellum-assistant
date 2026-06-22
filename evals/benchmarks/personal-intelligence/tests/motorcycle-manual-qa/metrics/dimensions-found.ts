import {
  readTranscript,
  type MetricInput,
  type MetricResult,
} from "../../../../../src/lib/metrics";
import {
  COMPATIBLE_FRAMES,
  ENGINE_BORE_MM,
  ENGINE_DISPLACEMENT_CC,
  ENGINE_STROKE_MM,
} from "../constants";

export default async function scoreDimensionsFound(
  input: MetricInput,
): Promise<MetricResult> {
  const transcript = await readTranscript(input.runId);
  const assistantText = transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content)
    .join("\n");
  const checks = [
    { criterion: "bore", passed: assistantText.includes(ENGINE_BORE_MM) },
    { criterion: "stroke", passed: assistantText.includes(ENGINE_STROKE_MM) },
    {
      criterion: "displacement",
      passed: assistantText.includes(ENGINE_DISPLACEMENT_CC),
    },
    {
      criterion: "frame-compatibility",
      passed: COMPATIBLE_FRAMES.some((frame) =>
        assistantText.toLowerCase().includes(frame.toLowerCase()),
      ),
    },
  ];
  const passed = checks.filter((c) => c.passed).length;
  return {
    name: "dimensions-found",
    score: passed / checks.length,
    reason: `${passed}/${checks.length} expected engine details recovered from the manual.`,
    metadata: { checks },
  };
}
