import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { AgentEvent, AgentMessage } from "./adapter";
import type { EvalProgressEvent } from "./runner/progress";
import type { TestDef } from "./test-def";
import type { TranscriptTurn } from "./transcript";

export interface PersistedProgressEvent extends EvalProgressEvent {
  /** ISO timestamp at which the runner emitted this event. */
  emittedAt: string;
}

export const RUNS_DIR = ".runs";

export interface UsageSummary {
  requests: Array<Record<string, unknown>>;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
}

export interface RunArtifacts {
  runDir: string;
  metadataPath: string;
  transcriptPath: string;
  assistantEventsPath: string;
  simulatorMessagesPath: string;
  usagePath: string;
  metricsPath: string;
  /**
   * NDJSON log of `EvalProgressEvent`s emitted by the runner for this run.
   * Surfaced in the UI as the test-runner-side log alongside container events.
   */
  progressLogPath: string;
}

export interface RunMetadata {
  runId: string;
  /**
   * Logical grouping for all (profile, test) executions launched by the same
   * `evals run` invocation. Legacy runs without a session id are treated as
   * single-execution sessions whose `sessionId` defaults to the `runId`.
   */
  sessionId?: string;
  /**
   * Optional human-readable tag set on the originating `evals run` invocation.
   * Same value is copied onto every execution belonging to the session.
   */
  sessionLabel?: string;
  profileId: string;
  testId: string;
  status: "running" | "completed" | "failed" | "unknown";
  startedAt?: string;
  completedAt?: string;
  error?: string;
  artifactDir: string;
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
    metadataPath: join(runDir, "run.json"),
    transcriptPath: join(runDir, "transcript.json"),
    assistantEventsPath: join(runDir, "assistant-events.json"),
    simulatorMessagesPath: join(runDir, "simulator-messages.json"),
    usagePath: join(runDir, "usage.json"),
    metricsPath: join(runDir, "metrics.json"),
    progressLogPath: join(runDir, "progress.ndjson"),
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
    writeJson(artifacts.metricsPath, []),
    writeFile(artifacts.progressLogPath, ""),
  ]);
  return artifacts;
}

export async function appendProgressEvent(
  runId: string,
  event: PersistedProgressEvent,
): Promise<void> {
  await appendFile(
    runArtifacts(runId).progressLogPath,
    `${JSON.stringify(event)}\n`,
  );
}

export async function readProgressEvents(
  runId: string,
): Promise<PersistedProgressEvent[]> {
  let raw: string;
  try {
    raw = await readFile(runArtifacts(runId).progressLogPath, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as PersistedProgressEvent);
}

export async function readRunMetadata(
  runId: string,
): Promise<RunMetadata | undefined> {
  return readJson<RunMetadata | undefined>(
    runArtifacts(runId).metadataPath,
    undefined,
  );
}

export async function writeRunMetadata(
  runId: string,
  metadata: RunMetadata,
): Promise<void> {
  await writeJson(runArtifacts(runId).metadataPath, metadata);
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

export async function readMetricResults(
  runId: string,
): Promise<MetricResult[]> {
  return readJson<MetricResult[]>(runArtifacts(runId).metricsPath, []);
}

export async function writeMetricResults(
  runId: string,
  metrics: MetricResult[],
): Promise<void> {
  await writeJson(runArtifacts(runId).metricsPath, metrics);
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
