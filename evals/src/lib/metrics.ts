import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentEvent, AgentMessage } from "./adapter";
import type { TestDef } from "./test-def";
import type { TranscriptTurn } from "./transcript";

export const RUNS_DIR = ".runs";

export interface UsageSummary {
  requests: Array<Record<string, unknown>>;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
}

export interface RunArtifacts {
  runDir: string;
  transcriptPath: string;
  assistantEventsPath: string;
  simulatorMessagesPath: string;
  usagePath: string;
}

export interface MetricInput {
  runId: string;
}

export interface MetricResult {
  name: string;
  score: number;
  reason?: string;
  metadata?: Record<string, unknown>;
}

export type MetricScorer = (
  input: MetricInput,
) => MetricResult | Promise<MetricResult>;

async function readJson<T>(path: string, fallback: T): Promise<T> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return fallback;
    throw err;
  }
}

async function writeJson(path: string, value: unknown): Promise<void> {
  await writeFile(path, JSON.stringify(value, null, 2));
}

export function runArtifacts(runId: string): RunArtifacts {
  const runDir = join(RUNS_DIR, runId);
  return {
    runDir,
    transcriptPath: join(runDir, "transcript.json"),
    assistantEventsPath: join(runDir, "assistant-events.json"),
    simulatorMessagesPath: join(runDir, "simulator-messages.json"),
    usagePath: join(runDir, "usage.json"),
  };
}

export async function ensureRunArtifacts(runId: string): Promise<RunArtifacts> {
  const artifacts = runArtifacts(runId);
  await mkdir(artifacts.runDir, { recursive: true });
  await Promise.all([
    writeJson(artifacts.transcriptPath, []),
    writeJson(artifacts.assistantEventsPath, []),
    writeJson(artifacts.simulatorMessagesPath, []),
    writeJson(artifacts.usagePath, { requests: [] } satisfies UsageSummary),
  ]);
  return artifacts;
}

export async function readTranscript(runId: string): Promise<TranscriptTurn[]> {
  return readJson<TranscriptTurn[]>(runArtifacts(runId).transcriptPath, []);
}

export async function writeTranscript(
  runId: string,
  transcript: TranscriptTurn[],
): Promise<void> {
  await writeJson(runArtifacts(runId).transcriptPath, transcript);
}

export async function appendTranscriptTurn(
  runId: string,
  turn: TranscriptTurn,
): Promise<void> {
  const transcript = await readTranscript(runId);
  transcript.push(turn);
  await writeTranscript(runId, transcript);
}

export async function readAssistantEvents(
  runId: string,
): Promise<AgentEvent[]> {
  return readJson<AgentEvent[]>(runArtifacts(runId).assistantEventsPath, []);
}

export async function appendAssistantEvents(
  runId: string,
  events: AgentEvent[],
): Promise<void> {
  if (events.length === 0) return;
  const existing = await readAssistantEvents(runId);
  existing.push(...events);
  await writeJson(runArtifacts(runId).assistantEventsPath, existing);
}

export async function readSimulatorMessages(
  runId: string,
): Promise<AgentMessage[]> {
  return readJson<AgentMessage[]>(
    runArtifacts(runId).simulatorMessagesPath,
    [],
  );
}

export async function appendSimulatorMessage(
  runId: string,
  message: AgentMessage,
): Promise<void> {
  const messages = await readSimulatorMessages(runId);
  messages.push(message);
  await writeJson(runArtifacts(runId).simulatorMessagesPath, messages);
}

export async function readUsage(runId: string): Promise<UsageSummary> {
  return readJson<UsageSummary>(runArtifacts(runId).usagePath, {
    requests: [],
  });
}

export async function writeUsage(
  runId: string,
  usage: UsageSummary,
): Promise<void> {
  await writeJson(runArtifacts(runId).usagePath, usage);
}

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

export async function runMetrics(input: {
  test: TestDef;
  runId: string;
}): Promise<MetricResult[]> {
  return Promise.all(
    input.test.metricPaths.map((path) =>
      runMetricFile(path, { runId: input.runId }),
    ),
  );
}
