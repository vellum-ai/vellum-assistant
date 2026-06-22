import {
  appendFile,
  mkdir,
  readdir,
  readFile,
  writeFile,
} from "node:fs/promises";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import type { AgentEvent, AgentMessage } from "./adapter";
import type { ProfileManifest } from "./profile";
import type { EvalProgressEvent } from "./runner/progress";
import type { TestDef } from "./test-def";
import type { TranscriptTurn } from "./transcript";

export interface PersistedProgressEvent extends EvalProgressEvent {
  /** ISO timestamp at which the runner emitted this event. */
  emittedAt: string;
}

export const RUNS_DIR = ".runs";

/**
 * Why a usage record could not be priced. Surfaced in the report's Usage
 * section so "cost: $0.00" doesn't quietly hide a missing field or an
 * unrecognized model.
 *
 *   - `missing_provider`   — the usage record had no `provider` or
 *                            `actualProvider` field. Common when an
 *                            adapter forgets to include identity on its
 *                            usage events.
 *   - `missing_model`      — no `model` field on the record.
 *   - `missing_tokens`     — neither input nor output token counts present;
 *                            nothing to price.
 *   - `unpriced_model`     — provider/model are known but our pricing
 *                            table has no entry for that pair. Bump the
 *                            table or fall back to a per-provider default.
 */
export type CostDiagnosticReason =
  | "missing_provider"
  | "missing_model"
  | "missing_tokens"
  | "unpriced_model";

export interface CostDiagnostic {
  /** 0-based index of the offending usage record in `requests`. */
  requestIndex: number;
  reason: CostDiagnosticReason;
  /** Provider observed (when present), for grouping/aggregation. */
  provider?: string;
  /** Model observed (when present). */
  model?: string;
}

/**
 * Coarse rollup of the cost-pricing pipeline for a single run.
 *   - `ok`      — every usage record priced cleanly.
 *   - `partial` — some priced, some emitted diagnostics.
 *   - `missing` — no requests priced (either no usage events at all,
 *                 or every record was unpriceable).
 */
export type CostStatus = "ok" | "partial" | "missing";

export interface UsageSummary {
  requests: Array<Record<string, unknown>>;
  totalInputTokens?: number;
  totalOutputTokens?: number;
  totalCostUsd?: number;
  /**
   * Pipeline status for the run's cost figure. When `partial` or
   * `missing`, `costDiagnostics` explains the gaps so the report shows
   * "why 0" instead of silently rendering "—".
   */
  costStatus?: CostStatus;
  /**
   * Per-request reasons a usage record could not be priced. Empty when
   * `costStatus === "ok"`. Used by `report-html.tsx` to surface the
   * gap in the Usage section.
   */
  costDiagnostics?: CostDiagnostic[];
}

export interface RunArtifacts {
  runDir: string;
  metadataPath: string;
  transcriptPath: string;
  assistantEventsPath: string;
  /**
   * Per-event log of the *ingest-turn* AgentEvents — the memory-formation
   * work the agent does while consuming the haystack sessions, separate
   * from the question-turn events in `assistant-events.json`. V2-only:
   * V1 runs have no ingest phase and leave this file as `[]` (the empty
   * default written by `ensureRunArtifacts`).
   */
  ingestAssistantEventsPath: string;
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
  /**
   * `process.argv` captured at the top of the originating `evals run`
   * invocation. Same value copied onto every execution belonging to the
   * session — the report UI surfaces a friendly `evals run …` line so an
   * operator opening a run page can read (and copy) the exact command
   * that produced it.
   *
   * Stored as the raw argv array, not a pre-joined string, so the
   * display layer owns formatting choices (shell-escaping rules, which
   * argv prefix to strip, etc.) and a future consumer that needs the
   * original tokenization isn't forced to re-split a string.
   *
   * Optional because legacy run.json files predate this field; the UI
   * renders "command unavailable" in that case and moves on.
   */
  cliArgv?: string[];
  profileId: string;
  /**
   * Snapshot of the profile's `manifest.json` (species, description,
   * version, setup) taken at run time. Persisted so the report's
   * per-profile info panel survives in an exported bundle, where the
   * `profiles/` directory the manifest was read from is no longer on disk.
   * Optional because legacy run.json files predate the field.
   */
  profileManifest?: ProfileManifest;
  testId: string;
  status: "running" | "completed" | "failed" | "abandoned" | "unknown";
  startedAt?: string;
  completedAt?: string;
  /** ISO timestamp of the last heartbeat. Used by the scavenger to detect stale runs. */
  lastHeartbeatAt?: string;
  error?: string;
  artifactDir: string;
}

export interface MetricInput {
  runId: string;
}

/**
 * How a metric's `score` should be rendered in the HTML report.
 *
 *   - `"fraction"` (default): `score` is a 0-1 quality fraction and the
 *      report renders it as `(score * 100).toFixed(N) + "%"`. This is the
 *      convention for almost every metric (date-mentioned, etc.) and
 *      matches what Vargas asked for in round-3 evals feedback.
 *   - `"raw"`: `score` carries a raw numeric value with units that have
 *      no meaning as a percent — e.g. `assistant-cost-usd` returns
 *      `-totalCostUsd` (negative dollars). Rendering `-$0.001 * 100%`
 *      would be nonsense, so the metric opts out of the percent treatment
 *      and the report formats it as a plain number.
 */
export type MetricUnit = "fraction" | "raw";

export interface MetricResult {
  name: string;
  score: number;
  reason?: string;
  metadata?: Record<string, unknown>;
  /** Render hint for the report. Defaults to `"fraction"` when omitted. */
  unit?: MetricUnit;
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

/**
 * Per-runId mutex for run.json writes. Prevents read-then-write races where
 * a heartbeat ticker reads `status: "running"`, suspends, the final
 * `completed`/`failed` write lands, and then the heartbeat continuation
 * clobbers it back to `running`. Every code path that mutates `run.json`
 * goes through `writeRunMetadata` or `updateRunMetadata`, both of which
 * serialize through this map.
 *
 * The map only grows for runs with active in-flight writers; entries
 * self-evict when the last queued op resolves and no successor has
 * been chained.
 */
const metadataLocks = new Map<string, Promise<unknown>>();

async function withMetadataLock<T>(
  runId: string,
  op: () => Promise<T>,
): Promise<T> {
  const prev = metadataLocks.get(runId) ?? Promise.resolve();
  // Always wait for the previous tail, even if it rejected; otherwise a
  // failing writer would poison every subsequent acquirer.
  const ours: Promise<T> = prev.then(op, op);
  metadataLocks.set(runId, ours);
  try {
    return await ours;
  } finally {
    // If nobody chained after us, drop the entry so the map doesn't grow
    // unbounded across the lifetime of the server.
    if (metadataLocks.get(runId) === ours) {
      metadataLocks.delete(runId);
    }
  }
}

export function runArtifacts(runId: string): RunArtifacts {
  const runDir = join(RUNS_DIR, runId);
  return {
    runDir,
    metadataPath: join(runDir, "run.json"),
    transcriptPath: join(runDir, "transcript.json"),
    assistantEventsPath: join(runDir, "assistant-events.json"),
    ingestAssistantEventsPath: join(runDir, "ingest-assistant-events.json"),
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
    writeJson(artifacts.ingestAssistantEventsPath, []),
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
  await withMetadataLock(runId, () =>
    writeJson(runArtifacts(runId).metadataPath, metadata),
  );
}

/**
 * Atomic read-modify-write for run.json. Acquires the per-runId mutex,
 * reads the current metadata, calls `updater`, and writes the result —
 * unless `updater` returns `undefined`, in which case the write is
 * skipped (use this to express "only write if state X").
 *
 * Returns the final on-disk metadata (or `undefined` if no write happened
 * because the file is missing or the updater bailed).
 *
 * This is the only safe way to do conditional run.json updates from
 * concurrent code paths (heartbeat ticker, scavenger, the run-once finally
 * block). Plain `readRunMetadata` followed by `writeRunMetadata` from
 * different async stacks can interleave and clobber the final status —
 * that's the race this PR is preventing.
 */
export async function updateRunMetadata(
  runId: string,
  updater: (
    current: RunMetadata | undefined,
  ) => RunMetadata | undefined | Promise<RunMetadata | undefined>,
): Promise<RunMetadata | undefined> {
  return withMetadataLock(runId, async () => {
    const current = await readRunMetadata(runId).catch(() => undefined);
    const next = await updater(current);
    if (next === undefined) return current;
    await writeJson(runArtifacts(runId).metadataPath, next);
    return next;
  });
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

const ASSISTANT_RESPONSE_EVENT_TYPES = new Set([
  "assistant_text_delta",
  "assistant_thinking_delta",
  "tool_use_start",
  "tool_result",
  "message_complete",
  "message_chunk",
]);

/**
 * Whether the assistant produced any substantive response in the run.
 * Tool-use-only and thinking-only turns create assistant events but no
 * transcript text, so an empty transcript alone does not mean the
 * assistant never responded.
 */
export async function hasAssistantResponse(runId: string): Promise<boolean> {
  const transcript = await readTranscript(runId);
  if (transcript.some((turn) => turn.role === "assistant")) return true;
  const events = await readAssistantEvents(runId);
  return events.some((event) =>
    ASSISTANT_RESPONSE_EVENT_TYPES.has(event.message.type),
  );
}

/**
 * All assistant-authored narration in the run: transcript text plus
 * streamed text/thinking deltas. Lets text-matching metrics evaluate
 * runs whose responses never made it into the persisted transcript.
 */
export async function readAssistantNarration(runId: string): Promise<string> {
  const transcript = await readTranscript(runId);
  const parts = transcript
    .filter((turn) => turn.role === "assistant")
    .map((turn) => turn.content);
  const events = await readAssistantEvents(runId);
  for (const event of events) {
    const msg = event.message;
    if (msg.type === "assistant_text_delta" && typeof msg.text === "string") {
      parts.push(msg.text);
    } else if (
      msg.type === "assistant_thinking_delta" &&
      typeof msg.thinking === "string"
    ) {
      parts.push(msg.thinking);
    } else if (msg.type === "message_chunk" && typeof msg.chunk === "string") {
      parts.push(msg.chunk);
    }
  }
  return parts.join("\n");
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

export async function readIngestAssistantEvents(
  runId: string,
): Promise<AgentEvent[]> {
  return readJson<AgentEvent[]>(
    runArtifacts(runId).ingestAssistantEventsPath,
    [],
  );
}

/**
 * Overwrite the V2 ingest-turn event log for `runId`. Symmetric with the
 * V2 question-turn write in `runner.ts`: `runIngestAsk` exposes the full
 * `ingestEvents` array up front, so we write the complete log in one pass
 * rather than appending per-turn the way V1 does for `assistant-events.json`.
 */
export async function writeIngestAssistantEvents(
  runId: string,
  events: AgentEvent[],
): Promise<void> {
  await writeJson(runArtifacts(runId).ingestAssistantEventsPath, events);
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

/** Default scavenger threshold: heartbeats older than this flip to `abandoned`. */
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 60_000;

export interface ScavengeOptions {
  /** Heartbeats older than this (ms) flip the run to `abandoned`. Defaults to 60s. */
  heartbeatTimeoutMs?: number;
  /** Injectable clock — tests pass a deterministic value. */
  now?: () => Date;
}

/**
 * Scan `.runs/` for any run whose `run.json` reports `status: "running"` but
 * whose heartbeat is older than `heartbeatTimeoutMs`. Flip those to
 * `status: "abandoned"` with an error message naming the last heartbeat time
 * so the report-server UI can show what happened.
 *
 * Called on startup of `evals run`/`evals server`, on every index page load,
 * and any time we suspect runs may have died uncleanly. Idempotent — once a
 * run is flipped it's no longer `running`, so a second scavenge pass is a no-op.
 */
export async function scavengeAbandonedRuns(
  options: ScavengeOptions = {},
): Promise<{ count: number; skipped: number }> {
  const heartbeatTimeoutMs =
    options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
  const now = options.now ? options.now() : new Date();
  const runDirs = await readdir(RUNS_DIR).catch(() => [] as string[]);
  let count = 0;
  let skipped = 0;

  for (const runDir of runDirs) {
    // updateRunMetadata serializes against in-flight heartbeats and final
    // writes — so a run that flipped to `completed` between our outer
    // check and the actual write won't be mistakenly marked `abandoned`.
    let scavenged = false;
    let stillFresh = false;
    await updateRunMetadata(runDir, (current) => {
      if (!current || current.status !== "running") return undefined;
      const lastHeartbeat = current.lastHeartbeatAt
        ? new Date(current.lastHeartbeatAt)
        : new Date(current.startedAt ?? 0);
      const timeSinceHeartbeat = now.getTime() - lastHeartbeat.getTime();
      if (timeSinceHeartbeat <= heartbeatTimeoutMs) {
        stillFresh = true;
        return undefined;
      }
      scavenged = true;
      return {
        ...current,
        status: "abandoned",
        completedAt: now.toISOString(),
        error: `Process exited without completing (last heartbeat: ${lastHeartbeat.toISOString()})`,
      };
    });
    if (scavenged) count++;
    else if (stillFresh) skipped++;
  }

  return { count, skipped };
}

/**
 * Synchronous variant of `scavengeAbandonedRuns` for use from signal
 * handlers. Forces every `status: "running"` run to `abandoned` regardless
 * of heartbeat age — when a SIGINT/SIGTERM lands, every in-flight run is
 * about to be killed by `process.exit`, so the threshold is meaningless.
 *
 * Uses `*Sync` FS APIs because the caller (`commands/run.ts` signal handler)
 * needs to complete before `process.exit` flushes the loop.
 */
export function abandonAllRunningRunsSync(input: {
  signal: NodeJS.Signals | "exit";
  now?: () => Date;
}): number {
  const now = input.now ? input.now() : new Date();
  let runDirs: string[];
  try {
    runDirs = readdirSync(RUNS_DIR);
  } catch {
    return 0;
  }
  let count = 0;
  for (const runDir of runDirs) {
    const metadataPath = join(RUNS_DIR, runDir, "run.json");
    let metadata: RunMetadata | undefined;
    try {
      const raw = readFileSync(metadataPath, "utf8");
      metadata = JSON.parse(raw) as RunMetadata;
    } catch {
      continue;
    }
    if (!metadata || metadata.status !== "running") continue;
    const next: RunMetadata = {
      ...metadata,
      status: "abandoned",
      completedAt: now.toISOString(),
      error:
        input.signal === "exit"
          ? "Process exited before run completed"
          : `Received signal ${input.signal} — process terminated before run completed`,
    };
    try {
      writeFileSync(metadataPath, JSON.stringify(next, null, 2));
      count += 1;
    } catch {
      // best-effort — the scavenger or `evals server` startup will pick
      // this up next time around.
    }
  }
  return count;
}

/**
 * Updates the `lastHeartbeatAt` timestamp on a run's metadata to now.
 * Called from `appendProgressEvent` and from the per-run heartbeat ticker
 * so the scavenger can tell a live process from a dead one.
 *
 * Uses `updateRunMetadata` for atomic read-modify-write, so the 5s
 * background ticker can't read `status: "running"`, suspend, and then
 * clobber a final `completed` write that lands in the gap. Inside the
 * lock we re-check `status === "running"` so a heartbeat that queued
 * while a final write was pending becomes a no-op.
 */
export async function updateHeartbeat(runId: string): Promise<void> {
  await updateRunMetadata(runId, (current) => {
    if (!current) return undefined;
    if (current.status !== "running") return undefined;
    return {
      ...current,
      lastHeartbeatAt: new Date().toISOString(),
    };
  });
}
