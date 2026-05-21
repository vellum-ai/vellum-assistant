import { readdir } from "node:fs/promises";

import {
  readAssistantEvents,
  readMetricResults,
  readProgressEvents,
  readRunMetadata,
  readSimulatorMessages,
  readTranscript,
  readUsage,
  RUNS_DIR,
  runArtifacts,
  type MetricResult,
  type PersistedProgressEvent,
  type RunMetadata,
  type UsageSummary,
} from "./metrics";
import type { AgentEvent, AgentMessage } from "./adapter";
import type { TranscriptTurn } from "./transcript";

/** Per-execution row used everywhere a single (profile, test) run is summarized. */
export interface ReportRunSummary {
  runId: string;
  sessionId: string;
  sessionLabel?: string;
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

/** Full execution detail — drilled-into view from session → test → profile. */
export interface ReportRunDetail extends ReportRunSummary {
  metadata?: RunMetadata;
  metrics: MetricResult[];
  transcript: TranscriptTurn[];
  usage: UsageSummary;
  assistantEvents: AgentEvent[];
  simulatorMessages: AgentMessage[];
  progressEvents: PersistedProgressEvent[];
}

export type SessionStatus =
  | "completed"
  | "failed"
  | "partial"
  | "running"
  | "unknown";

/** Aggregate of one profile's runs inside a session. */
export interface SessionProfileAggregate {
  profileId: string;
  runCount: number;
  completedCount: number;
  failedCount: number;
  runningCount: number;
  scoreTotal: number;
}

/** One test row inside a session detail page. */
export interface SessionTestEntry {
  testId: string;
  /**
   * Equal-weighted mean score across every metric of every run that
   * belongs to this test in the session (see `aggregateScore`). The view
   * should render this, not a per-profile sum.
   */
  scoreTotal: number;
  profiles: Array<{
    profileId: string;
    runId: string;
    status: ReportRunSummary["status"];
    scoreTotal: number;
  }>;
}

/** Session row on the index page. */
export interface ReportSessionSummary {
  sessionId: string;
  sessionLabel?: string;
  runCount: number;
  profileIds: string[];
  testIds: string[];
  startedAt?: string;
  completedAt?: string;
  scoreTotal: number;
  status: SessionStatus;
}

/** Session detail = summary + per-profile aggregates + per-test list. */
export interface ReportSessionDetail extends ReportSessionSummary {
  profiles: SessionProfileAggregate[];
  tests: SessionTestEntry[];
}

/** Test-in-session drill-in: how each profile performed on this test. */
export interface ReportTestInSession {
  sessionId: string;
  sessionLabel?: string;
  testId: string;
  profiles: Array<{
    profileId: string;
    runId: string;
    status: ReportRunSummary["status"];
    scoreTotal: number;
    metricCount: number;
    metrics: MetricResult[];
    transcriptTurns: number;
    totalCostUsd?: number;
  }>;
}

function scoreTotal(metrics: MetricResult[]): number {
  if (metrics.length === 0) return 0;
  const weight = 1 / metrics.length;
  return metrics.reduce((sum, metric) => sum + metric.score * weight, 0);
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
    // Legacy runs predate the session model. Treat them as their own
    // single-execution session so URLs stay valid and the index doesn't
    // explode on mixed data.
    sessionId: input.metadata?.sessionId ?? input.runId,
    sessionLabel: input.metadata?.sessionLabel,
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
    progressEvents,
  ] = await Promise.all([
    readRunMetadata(runId),
    readMetricResults(runId),
    readTranscript(runId),
    readUsage(runId),
    readAssistantEvents(runId),
    readSimulatorMessages(runId),
    readProgressEvents(runId),
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
    progressEvents,
  };
}

/**
 * Load every run on disk and project to summary rows. Heavy operation — used
 * as the input to every session-level view since sessions are derived by
 * grouping summaries.
 */
async function listAllRunSummaries(): Promise<ReportRunSummary[]> {
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
      progressEvents: _progressEvents,
      ...summary
    }) => summary,
  );
}

function uniq<T>(values: Iterable<T>): T[] {
  return Array.from(new Set(values));
}

function deriveSessionStatus(runs: ReportRunSummary[]): SessionStatus {
  if (runs.length === 0) return "unknown";
  const states = new Set(runs.map((run) => run.status));
  if (states.has("running")) return "running";
  const hasFailed = states.has("failed");
  const hasCompleted = states.has("completed");
  if (hasFailed && hasCompleted) return "partial";
  if (hasFailed) return "failed";
  if (hasCompleted) return "completed";
  return "unknown";
}

function earliest(values: Array<string | undefined>): string | undefined {
  const defined = values.filter((value): value is string => Boolean(value));
  if (defined.length === 0) return undefined;
  return defined.sort()[0];
}

function latest(values: Array<string | undefined>): string | undefined {
  const defined = values.filter((value): value is string => Boolean(value));
  if (defined.length === 0) return undefined;
  return defined.sort().slice(-1)[0];
}

function aggregateScore(runs: ReportRunSummary[]): number {
  const metricCount = runs.reduce((sum, run) => sum + run.metricCount, 0);
  if (metricCount === 0) return 0;
  return (
    runs.reduce((sum, run) => sum + run.scoreTotal * run.metricCount, 0) /
    metricCount
  );
}

function summarizeSession(runs: ReportRunSummary[]): ReportSessionSummary {
  const first = runs[0];
  return {
    sessionId: first.sessionId,
    sessionLabel: first.sessionLabel,
    runCount: runs.length,
    profileIds: uniq(
      runs
        .map((run) => run.profileId)
        .filter((value): value is string => Boolean(value)),
    ).sort(),
    testIds: uniq(
      runs
        .map((run) => run.testId)
        .filter((value): value is string => Boolean(value)),
    ).sort(),
    startedAt: earliest(runs.map((run) => run.startedAt)),
    completedAt: latest(runs.map((run) => run.completedAt)),
    scoreTotal: aggregateScore(runs),
    status: deriveSessionStatus(runs),
  };
}

function groupBySession(
  runs: ReportRunSummary[],
): Map<string, ReportRunSummary[]> {
  const groups = new Map<string, ReportRunSummary[]>();
  for (const run of runs) {
    const list = groups.get(run.sessionId);
    if (list) {
      list.push(run);
    } else {
      groups.set(run.sessionId, [run]);
    }
  }
  return groups;
}

export async function listReportSessions(): Promise<ReportSessionSummary[]> {
  const runs = await listAllRunSummaries();
  const sessions = Array.from(groupBySession(runs).values()).map(
    summarizeSession,
  );
  // Most-recently-started sessions first. Sessions without a startedAt fall
  // to the bottom so they don't outrank anything real.
  return sessions.sort((a, b) => {
    const left = b.startedAt ?? "";
    const right = a.startedAt ?? "";
    return left.localeCompare(right);
  });
}

function aggregateByProfile(
  runs: ReportRunSummary[],
): SessionProfileAggregate[] {
  const groups = new Map<string, ReportRunSummary[]>();
  for (const run of runs) {
    const key = run.profileId ?? "unknown";
    const list = groups.get(key);
    if (list) list.push(run);
    else groups.set(key, [run]);
  }
  return Array.from(groups.entries())
    .map(([profileId, profileRuns]) => ({
      profileId,
      runCount: profileRuns.length,
      completedCount: profileRuns.filter((run) => run.status === "completed")
        .length,
      failedCount: profileRuns.filter((run) => run.status === "failed").length,
      runningCount: profileRuns.filter((run) => run.status === "running")
        .length,
      scoreTotal: aggregateScore(profileRuns),
    }))
    .sort((a, b) => a.profileId.localeCompare(b.profileId));
}

function buildTestEntries(runs: ReportRunSummary[]): SessionTestEntry[] {
  const groups = new Map<string, ReportRunSummary[]>();
  for (const run of runs) {
    const key = run.testId ?? "unknown";
    const list = groups.get(key);
    if (list) list.push(run);
    else groups.set(key, [run]);
  }
  return Array.from(groups.entries())
    .map(([testId, testRuns]) => ({
      testId,
      scoreTotal: aggregateScore(testRuns),
      profiles: testRuns
        .map((run) => ({
          profileId: run.profileId ?? "unknown",
          runId: run.runId,
          status: run.status,
          scoreTotal: run.scoreTotal,
        }))
        .sort((a, b) => a.profileId.localeCompare(b.profileId)),
    }))
    .sort((a, b) => a.testId.localeCompare(b.testId));
}

export async function readReportSession(
  sessionId: string,
): Promise<ReportSessionDetail | undefined> {
  const allRuns = await listAllRunSummaries();
  const runs = allRuns.filter((run) => run.sessionId === sessionId);
  if (runs.length === 0) return undefined;
  const summary = summarizeSession(runs);
  return {
    ...summary,
    profiles: aggregateByProfile(runs),
    tests: buildTestEntries(runs),
  };
}

export async function readTestInSession(
  sessionId: string,
  testId: string,
): Promise<ReportTestInSession | undefined> {
  const allRuns = await listAllRunSummaries();
  const matching = allRuns.filter(
    (run) => run.sessionId === sessionId && run.testId === testId,
  );
  if (matching.length === 0) return undefined;

  // We need metrics per run for the drill-down — load the full detail rather
  // than only the summary so the "summary of how each profile performed"
  // section can render metric-by-metric breakdowns.
  const details = await Promise.all(
    matching.map((run) => readReportRun(run.runId)),
  );

  return {
    sessionId,
    sessionLabel: matching[0].sessionLabel,
    testId,
    profiles: details
      .map((detail) => ({
        profileId: detail.profileId ?? "unknown",
        runId: detail.runId,
        status: detail.status,
        scoreTotal: detail.scoreTotal,
        metricCount: detail.metricCount,
        metrics: detail.metrics,
        transcriptTurns: detail.transcriptTurns,
        totalCostUsd: detail.totalCostUsd,
      }))
      .sort((a, b) => a.profileId.localeCompare(b.profileId)),
  };
}

/**
 * Resolve the (sessionId, testId, profileId) triple to a specific execution.
 * Used by the deepest drill-in page to load the full transcript + log view.
 */
export async function findExecutionRunId(
  sessionId: string,
  testId: string,
  profileId: string,
): Promise<string | undefined> {
  const allRuns = await listAllRunSummaries();
  const match = allRuns.find(
    (run) =>
      run.sessionId === sessionId &&
      run.testId === testId &&
      run.profileId === profileId,
  );
  return match?.runId;
}
