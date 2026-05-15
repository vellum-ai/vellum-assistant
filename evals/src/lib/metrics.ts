import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import type { AgentEvent, AgentMessage } from "./adapter";
import type { Profile } from "./profile";
import type { TestDef } from "./test-def";
import type { TranscriptTurn } from "./transcript";

export interface UsageSummary {
  requests: Array<Record<string, unknown>>;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
}

export interface MetricArtifacts {
  transcriptPath: string;
  assistantEventsPath: string;
  simulatorMessagesPath: string;
  usagePath: string;
}

export interface MetricContext {
  profile: Profile;
  test: TestDef;
  runId: string;
  artifactDir: string;
  artifacts: MetricArtifacts;
  readTranscript(): Promise<TranscriptTurn[]>;
  readAssistantEvents(): Promise<AgentEvent[]>;
  readSimulatorMessages(): Promise<AgentMessage[]>;
  readUsage(): Promise<UsageSummary>;
}

export interface MetricResult {
  name: string;
  score: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type MetricScorer = (
  context: MetricContext,
) => MetricResult | Promise<MetricResult>;

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

export function metricArtifactPaths(artifactDir: string): MetricArtifacts {
  return {
    transcriptPath: join(artifactDir, "transcript.json"),
    assistantEventsPath: join(artifactDir, "assistant-events.json"),
    simulatorMessagesPath: join(artifactDir, "simulator-messages.json"),
    usagePath: join(artifactDir, "usage.json"),
  };
}

export async function writeMetricArtifacts(
  artifacts: MetricArtifacts,
  values: {
    transcript: TranscriptTurn[];
    assistantEvents: AgentEvent[];
    simulatorMessages: AgentMessage[];
    usage: UsageSummary;
  },
): Promise<void> {
  await mkdir(dirname(artifacts.transcriptPath), { recursive: true });
  await Promise.all([
    writeFile(
      artifacts.transcriptPath,
      JSON.stringify(values.transcript, null, 2),
    ),
    writeFile(
      artifacts.assistantEventsPath,
      JSON.stringify(values.assistantEvents, null, 2),
    ),
    writeFile(
      artifacts.simulatorMessagesPath,
      JSON.stringify(values.simulatorMessages, null, 2),
    ),
    writeFile(artifacts.usagePath, JSON.stringify(values.usage, null, 2)),
  ]);
}

export function createMetricContext(input: {
  profile: Profile;
  test: TestDef;
  runId: string;
  artifactDir: string;
}): MetricContext {
  const artifacts = metricArtifactPaths(input.artifactDir);
  return {
    ...input,
    artifacts,
    readTranscript: () =>
      readJson<TranscriptTurn[]>(artifacts.transcriptPath, []),
    readAssistantEvents: () =>
      readJson<AgentEvent[]>(artifacts.assistantEventsPath, []),
    readSimulatorMessages: () =>
      readJson<AgentMessage[]>(artifacts.simulatorMessagesPath, []),
    readUsage: () =>
      readJson<UsageSummary>(artifacts.usagePath, { requests: [] }),
  };
}

export async function runMetricFile(
  path: string,
  context: MetricContext,
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
  return scorer(context);
}

export async function runMetrics(
  context: MetricContext,
): Promise<MetricResult[]> {
  return Promise.all(
    context.test.metricPaths.map((path) => runMetricFile(path, context)),
  );
}
