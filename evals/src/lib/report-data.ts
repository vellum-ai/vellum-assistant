import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import {
  readAssistantEvents,
  readIngestAssistantEvents,
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
import type { ProfileManifest } from "./profile";
import type { TranscriptTurn } from "./transcript";
import { buildTranscriptView } from "./transcript-view";

/**
 * How many distinct assistant replies a run took — one per user↔assistant
 * exchange, not per streamed chunk or LLM API call. The persisted transcript
 * stores one entry per `assistant_text_delta`, so a single streamed answer is
 * many raw turns; folding the event stream back into whole messages
 * (`buildTranscriptView`) collapses those deltas so the count reflects
 * exchanges the way a reader counts them.
 */
function countAssistantResponses(
  transcript: TranscriptTurn[],
  assistantEvents: AgentEvent[],
): number {
  return buildTranscriptView(transcript, assistantEvents).filter(
    (item) => item.role === "assistant",
  ).length;
}

/** Wall-clock run duration in ms, when both timestamps were recorded. */
function runtimeMs(metadata: RunMetadata | undefined): number | undefined {
  if (!metadata?.startedAt || !metadata?.completedAt) return undefined;
  const start = Date.parse(metadata.startedAt);
  const end = Date.parse(metadata.completedAt);
  if (Number.isNaN(start) || Number.isNaN(end)) return undefined;
  return Math.max(0, end - start);
}

/** Per-execution row used everywhere a single (profile, test) run is summarized. */
export interface ReportRunSummary {
  runId: string;
  sessionId: string;
  sessionLabel?: string;
  /**
   * `process.argv` captured at the top of the originating `evals run`.
   * Surfaced by the report UI as the canonical "how do I reproduce
   * this run" line. Undefined for legacy runs that predate the field.
   */
  cliArgv?: string[];
  profileId?: string;
  /**
   * Snapshot of the profile's manifest captured at run time (species,
   * description, version, setup). Carried through from `run.json` so the
   * report's per-profile info panel works in an exported bundle. Undefined
   * for legacy runs that predate the field.
   */
  profileManifest?: ProfileManifest;
  testId?: string;
  status: RunMetadata["status"] | "unknown";
  startedAt?: string;
  completedAt?: string;
  metricCount: number;
  scoreTotal: number;
  /** Number of distinct assistant replies (folded), not raw transcript deltas. */
  assistantResponses: number;
  /** Wall-clock duration in ms, when both run timestamps were recorded. */
  runtimeMs?: number;
  assistantEventCount: number;
  simulatorMessageCount: number;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
}

/**
 * One per-subprocess log written by an adapter (Vellum hatch, Hermes setup, …).
 *
 * Carries the on-disk filename so the report UI can link to the raw file
 * download, plus the full file contents so the same UI can inline-render
 * the log in the same `[ts] [step] glyph msg` shape as the runner log.
 * Vargas's feedback called out that scrolling to a separate file just to
 * see why hatch failed was a regression vs. the previous in-page surface.
 */
export interface SubprocessLogFile {
  name: string;
  content: string;
}

/**
 * One docker-forensics artifact written by the vellum adapter's catch
 * path (`captureContainerForensics`) on hatch failure. Same name+content
 * shape as `SubprocessLogFile` so the report UI can render them inline
 * alongside subprocess logs instead of as bare download links —
 * scrolling to a separate file to see *why* a container died was the
 * same regression we already fixed for subprocess logs in #31918.
 */
export interface DockerArtifactFile {
  name: string;
  content: string;
  /** "json" for `docker-inspect-*.json`, "text" for `docker-logs-*.txt`. */
  kind: "json" | "text";
}

/** Full execution detail — drilled-into view from session → test → profile. */
export interface ReportRunDetail extends ReportRunSummary {
  metadata?: RunMetadata;
  metrics: MetricResult[];
  transcript: TranscriptTurn[];
  usage: UsageSummary;
  assistantEvents: AgentEvent[];
  /**
   * V2 only: the ingest-turn AgentEvents (memory-formation work
   * consuming the haystack sessions). Empty for V1 runs, which have no
   * ingest phase. Rendered in its own report section so the
   * question-turn view in `assistantEvents` stays focused on what the
   * agent said in response to the question.
   */
  ingestAssistantEvents: AgentEvent[];
  simulatorMessages: AgentMessage[];
  progressEvents: PersistedProgressEvent[];
  /**
   * Per-subprocess stdout/stderr logs the adapters tee'd to the run
   * directory (e.g. `subprocess-hatch.log`, `subprocess-setup-1.log`).
   * Each entry carries the filename plus the full file content so the
   * UI can inline-render the log in the same shape as the runner log
   * AND still expose a raw-download link at
   * `/api/runs/<runId>/files/<name>` for piping into other tools.
   * Empty when no adapter call produced a log.
   */
  subprocessLogs: SubprocessLogFile[];
  /**
   * Container-forensics artifacts the vellum adapter wrote on hatch
   * failure — `docker-inspect-<service>.json` (raw `docker inspect`
   * output) and `docker-logs-<service>.txt` (last 200 stdout/stderr
   * lines), one pair per `vellumDockerSiblingContainers` entry.
   *
   * Each entry carries the filename + full file content so the UI can
   * inline-render the snapshot in the same way as `subprocessLogs`. The
   * raw download link still lives at `/api/runs/<runId>/files/<name>`.
   * Empty when the run never hit the hatch catch path.
   */
  dockerArtifacts: DockerArtifactFile[];
}

export type SessionStatus =
  | "completed"
  | "failed"
  | "abandoned"
  | "partial"
  | "running"
  | "unknown";

/** Aggregate of one profile's runs inside a session. */
export interface SessionProfileAggregate {
  profileId: string;
  /**
   * The profile's manifest, taken from any run of this profile in the
   * session (all runs of a profile share one manifest). Drives the
   * per-profile info panel. Undefined for legacy runs without the field.
   */
  info?: ProfileManifest;
  runCount: number;
  completedCount: number;
  failedCount: number;
  runningCount: number;
  scoreTotal: number;
  /** Sum of every run's wall-clock runtime (ms) — undefined when any run lacks it. */
  totalRuntimeMs?: number;
  /** Sum of every run's cost (USD cents) — undefined when any run lacks it. */
  totalCostUsd?: number;
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
  /**
   * `process.argv` of the `evals run` that produced this session. All
   * runs in a session share the same value, so we lift it onto the
   * session summary directly (taken from the first run). Undefined for
   * legacy sessions that predate the field.
   */
  cliArgv?: string[];
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

/** Profile-in-session drill-in: how this profile scored on every test. */
export interface ReportProfileInSession {
  sessionId: string;
  sessionLabel?: string;
  profileId: string;
  /** Profile manifest (species, description, version, setup) for the info panel. */
  info?: ProfileManifest;
  /**
   * Equal-weighted mean across every metric of every run this profile
   * produced in the session — the profile's overall score, mirroring the
   * card on the session page.
   */
  scoreTotal: number;
  tests: Array<{
    testId: string;
    runId: string;
    status: ReportRunSummary["status"];
    scoreTotal: number;
    metricCount: number;
    metrics: MetricResult[];
    assistantResponses: number;
    runtimeMs?: number;
    totalCostUsd?: number;
  }>;
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
    assistantResponses: number;
    runtimeMs?: number;
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
  /**
   * V2 ingest-turn events. Counted alongside `assistantEvents` so the
   * Responses total reflects every conversation in the run, not just the
   * question turn — mirroring the Transcript view, which folds both event
   * streams together. Empty for V1 runs.
   */
  ingestAssistantEvents?: AgentEvent[];
  simulatorMessages: AgentMessage[];
}): ReportRunSummary {
  return {
    runId: input.runId,
    // Legacy runs predate the session model. Treat them as their own
    // single-execution session so URLs stay valid and the index doesn't
    // explode on mixed data.
    sessionId: input.metadata?.sessionId ?? input.runId,
    sessionLabel: input.metadata?.sessionLabel,
    cliArgv: input.metadata?.cliArgv,
    profileId: input.metadata?.profileId,
    profileManifest: input.metadata?.profileManifest,
    testId: input.metadata?.testId,
    status: fallbackStatus(input.metadata),
    startedAt: input.metadata?.startedAt,
    completedAt: input.metadata?.completedAt,
    metricCount: input.metrics.length,
    scoreTotal: scoreTotal(input.metrics),
    assistantResponses: countAssistantResponses(
      input.transcript,
      // Fold both event streams so a two-conversation (ingest → ask) run
      // counts the assistant's ingest replies too, not just the question
      // turn — matches the Transcript view's `[...ingest, ...question]`.
      [...(input.ingestAssistantEvents ?? []), ...input.assistantEvents],
    ),
    runtimeMs: runtimeMs(input.metadata),
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

/**
 * Set of bare filenames that may appear at the top of a run directory and
 * should NOT be surfaced as `subprocessLogs` or `dockerArtifacts` (they're
 * the structured artifacts loaded by their own readers above).
 */
const STRUCTURED_RUN_FILES = new Set<string>([
  "run.json",
  "metrics.json",
  "transcript.json",
  "assistant-events.json",
  "ingest-assistant-events.json",
  "simulator-messages.json",
  "usage.json",
  "progress.ndjson",
]);

/**
 * Filename patterns the docker-forensics capture path writes on hatch
 * failure — `docker-inspect-<service>.json` / `docker-logs-<service>.txt`,
 * one pair per `vellumDockerSiblingContainers` entry. Pattern match so a
 * new sibling doesn't silently disappear from the UI.
 */
const DOCKER_INSPECT_RE = /^docker-inspect-[a-z0-9\-]+\.json$/;
const DOCKER_LOGS_RE = /^docker-logs-[a-z0-9\-]+\.txt$/;

/**
 * List run-directory files that should be surfaced inline on the
 * run-detail page. Returns subprocess logs AND docker forensics with
 * their full contents already loaded so the UI can inline-render both
 * in the same `[ts] [step] glyph msg` shape — the regression Vargas
 * flagged in 2026-05 was the docker snapshot section dropping back to
 * bare download links while the rest of the logs went inline in #31918.
 *
 * Per-file read errors collapse to an empty `content` so one unreadable
 * file doesn't blank the whole page; the operator still sees the entry
 * (and can hit `/api/runs/<runId>/files/<name>` directly).
 */
async function listExtraArtifacts(runDir: string): Promise<{
  subprocessLogs: SubprocessLogFile[];
  dockerArtifacts: DockerArtifactFile[];
}> {
  let entries: string[];
  try {
    entries = await readdir(runDir);
  } catch {
    return { subprocessLogs: [], dockerArtifacts: [] };
  }
  const subprocessNames: string[] = [];
  const dockerNames: Array<{ name: string; kind: "json" | "text" }> = [];
  for (const name of entries.sort()) {
    if (STRUCTURED_RUN_FILES.has(name)) continue;
    if (DOCKER_INSPECT_RE.test(name)) {
      dockerNames.push({ name, kind: "json" });
      continue;
    }
    if (DOCKER_LOGS_RE.test(name)) {
      dockerNames.push({ name, kind: "text" });
      continue;
    }
    if (/^subprocess-[a-z0-9\-]+\.log$/.test(name)) {
      subprocessNames.push(name);
      continue;
    }
  }
  const [subprocessLogs, dockerArtifacts] = await Promise.all([
    Promise.all(
      subprocessNames.map(async (name) => ({
        name,
        content: await readFile(join(runDir, name), "utf8").catch(() => ""),
      })),
    ),
    Promise.all(
      dockerNames.map(async ({ name, kind }) => ({
        name,
        kind,
        content: await readFile(join(runDir, name), "utf8").catch(() => ""),
      })),
    ),
  ]);
  return { subprocessLogs, dockerArtifacts };
}

export async function readReportRun(runId: string): Promise<ReportRunDetail> {
  const artifacts = runArtifacts(runId);
  const [
    metadata,
    metrics,
    transcript,
    usage,
    assistantEvents,
    ingestAssistantEvents,
    simulatorMessages,
    progressEvents,
    extras,
  ] = await Promise.all([
    readRunMetadata(runId),
    readMetricResults(runId),
    readTranscript(runId),
    readUsage(runId),
    readAssistantEvents(runId),
    readIngestAssistantEvents(runId),
    readSimulatorMessages(runId),
    readProgressEvents(runId),
    listExtraArtifacts(artifacts.runDir),
  ]);

  const summary = summarize({
    runId,
    metadata,
    metrics,
    transcript,
    usage,
    assistantEvents,
    ingestAssistantEvents,
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
    ingestAssistantEvents,
    simulatorMessages,
    progressEvents,
    subprocessLogs: extras.subprocessLogs,
    dockerArtifacts: extras.dockerArtifacts,
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
      ingestAssistantEvents: _ingestAssistantEvents,
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
  const hasAbandoned = states.has("abandoned");
  // Mixed terminal outcomes — surface as "partial" so the index makes it
  // clear something didn't fully succeed. Abandoned counts as a non-success.
  if ((hasFailed || hasAbandoned) && hasCompleted) return "partial";
  if (hasFailed) return "failed";
  // All terminal runs are abandoned — surface that explicitly so it's
  // distinguishable from clean failure and so the user knows to investigate
  // stuck/killed processes rather than test bugs.
  if (hasAbandoned) return "abandoned";
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
    // `cliArgv` is stamped onto every run in the session with the same
    // value (commands/run.ts captures it once per invocation), so the
    // first row is authoritative. Falling back to `find` on a later
    // run with a defined value would only matter if upstream contracts
    // drift — call it out then; we don't want to mask that here.
    cliArgv: first.cliArgv,
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
      // All runs of a profile in a session share one manifest; the first
      // run that carries it is authoritative (undefined for legacy runs).
      info: profileRuns.find((run) => run.profileManifest)?.profileManifest,
      runCount: profileRuns.length,
      completedCount: profileRuns.filter((run) => run.status === "completed")
        .length,
      failedCount: profileRuns.filter((run) => run.status === "failed").length,
      runningCount: profileRuns.filter((run) => run.status === "running")
        .length,
      scoreTotal: aggregateScore(profileRuns),
      // Sum per-run runtime/cost. Undefined when any run lacks the field
      // (legacy runs) so the UI shows "—" rather than a misleading partial sum.
      totalRuntimeMs: profileRuns.every((r) => r.runtimeMs !== undefined)
        ? profileRuns.reduce((sum, r) => sum + (r.runtimeMs ?? 0), 0)
        : undefined,
      totalCostUsd: profileRuns.every((r) => r.totalCostUsd !== undefined)
        ? profileRuns.reduce((sum, r) => sum + (r.totalCostUsd ?? 0), 0)
        : undefined,
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

export async function readProfileInSession(
  sessionId: string,
  profileId: string,
): Promise<ReportProfileInSession | undefined> {
  const allRuns = await listAllRunSummaries();
  const matching = allRuns.filter(
    (run) => run.sessionId === sessionId && run.profileId === profileId,
  );
  if (matching.length === 0) return undefined;

  // Load full detail per run so the per-test rows can show metric counts
  // and cost, mirroring the test-in-session drill-in.
  const details = await Promise.all(
    matching.map((run) => readReportRun(run.runId)),
  );

  return {
    sessionId,
    sessionLabel: matching[0].sessionLabel,
    profileId,
    info: matching.find((run) => run.profileManifest)?.profileManifest,
    scoreTotal: aggregateScore(matching),
    tests: details
      .map((detail) => ({
        testId: detail.testId ?? "unknown",
        runId: detail.runId,
        status: detail.status,
        scoreTotal: detail.scoreTotal,
        metricCount: detail.metricCount,
        metrics: detail.metrics,
        assistantResponses: detail.assistantResponses,
        runtimeMs: detail.runtimeMs,
        totalCostUsd: detail.totalCostUsd,
      }))
      .sort((a, b) => a.testId.localeCompare(b.testId)),
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
        assistantResponses: detail.assistantResponses,
        runtimeMs: detail.runtimeMs,
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
