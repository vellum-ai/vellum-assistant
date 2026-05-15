import type { AgentEvent, AgentMessage } from "./adapter";
import type { Profile } from "./profile";
import type { TestDef } from "./test-def";

export interface TranscriptTurn {
  role: "simulator" | "assistant";
  content: string;
  emittedAt: string;
}

export interface MetricInput {
  profile: Profile;
  test: TestDef;
  transcript: TranscriptTurn[];
  assistantEvents: AgentEvent[];
  simulatorMessages: AgentMessage[];
}

export interface MetricResult {
  name: string;
  score: number;
  passed: boolean;
  reason: string;
  metadata?: Record<string, unknown>;
}

export type MetricScorer = (
  input: MetricInput,
) => MetricResult | Promise<MetricResult>;

export async function runMetricFile(
  path: string,
  input: MetricInput,
): Promise<MetricResult> {
  const imported = (await import(path)) as {
    default?: MetricScorer;
    scorer?: MetricScorer;
  };
  const scorer = imported.default ?? imported.scorer;
  if (!scorer) {
    throw new Error(
      `Metric file ${path} must export a default scorer or named scorer`,
    );
  }
  return scorer(input);
}

export async function runMetrics(input: MetricInput): Promise<MetricResult[]> {
  const results: MetricResult[] = [];
  for (const path of input.test.metricPaths) {
    results.push(await runMetricFile(path, input));
  }
  return results;
}
