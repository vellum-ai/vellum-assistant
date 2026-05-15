import { readdir } from "node:fs/promises";

import {
  readAssistantEvents,
  readMetricResults,
  readRunMetadata,
  readSimulatorMessages,
  readTranscript,
  readUsage,
  RUNS_DIR,
  runArtifacts,
  type MetricResult,
  type RunMetadata,
  type UsageSummary,
} from "./metrics";
import type { AgentEvent, AgentMessage } from "./adapter";
import type { TranscriptTurn } from "./transcript";

export interface ReportRunSummary {
  runId: string;
  profileId?: string;
  testId?: string;
  status: RunMetadata["status"] | "unknown";
  startedAt?: string;
  completedAt?: string;
  metricCount: number;
  scoreTotal: number;
  transcriptTurns: number;
  assistantEventCount: number;
  simulatorMessageCount: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
}

export interface ReportRunDetail extends ReportRunSummary {
  metadata?: RunMetadata;
  metrics: MetricResult[];
  transcript: TranscriptTurn[];
  usage: UsageSummary;
  assistantEvents: AgentEvent[];
  simulatorMessages: AgentMessage[];
}

function scoreTotal(metrics: MetricResult[]): number {
  return metrics.reduce((sum, metric) => sum + metric.score, 0);
}

function fallbackStatus(
  metadata: RunMetadata | undefined,
): ReportRunSummary["status"] {
  return metadata?.status ?? "unknown";
}

function summarize(input: {
  runId: string;
  metadata?: RunMetadata;
  metrics: MetricResult[];
  transcript: TranscriptTurn[];
  usage: UsageSummary;
  assistantEvents: AgentEvent[];
  simulatorMessages: AgentMessage[];
}): ReportRunSummary {
  return {
    runId: input.runId,
    profileId: input.metadata?.profileId,
    testId: input.metadata?.testId,
    status: fallbackStatus(input.metadata),
    startedAt: input.metadata?.startedAt,
    completedAt: input.metadata?.completedAt,
    metricCount: input.metrics.length,
    scoreTotal: scoreTotal(input.metrics),
    transcriptTurns: input.transcript.length,
    assistantEventCount: input.assistantEvents.length,
    simulatorMessageCount: input.simulatorMessages.length,
    totalInputTokens: input.usage.totalInputTokens,
    totalOutputTokens: input.usage.totalOutputTokens,
    totalCostUsd: input.usage.totalCostUsd,
  };
}

export async function listReportRunIds(): Promise<string[]> {
  try {
    const entries = await readdir(RUNS_DIR, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort()
      .reverse();
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw err;
  }
}

export async function readReportRun(runId: string): Promise<ReportRunDetail> {
  const artifacts = runArtifacts(runId);
  const [
    metadata,
    metrics,
    transcript,
    usage,
    assistantEvents,
    simulatorMessages,
  ] = await Promise.all([
    readRunMetadata(runId),
    readMetricResults(runId),
    readTranscript(runId),
    readUsage(runId),
    readAssistantEvents(runId),
    readSimulatorMessages(runId),
  ]);

  const summary = summarize({
    runId,
    metadata,
    metrics,
    transcript,
    usage,
    assistantEvents,
    simulatorMessages,
  });

  return {
    ...summary,
    metadata: metadata ?? {
      runId,
      profileId: "unknown",
      testId: "unknown",
      status: "unknown",
      startedAt: undefined,
      artifactDir: artifacts.runDir,
    },
    metrics,
    transcript,
    usage,
    assistantEvents,
    simulatorMessages,
  };
}

export async function listReportRuns(): Promise<ReportRunSummary[]> {
  const runIds = await listReportRunIds();
  const runs = await Promise.all(runIds.map((runId) => readReportRun(runId)));
  return runs.map(
    ({
      metadata: _metadata,
      metrics: _metrics,
      transcript: _transcript,
      usage: _usage,
      assistantEvents: _assistantEvents,
      simulatorMessages: _simulatorMessages,
      ...summary
    }) => summary,
  );
}
