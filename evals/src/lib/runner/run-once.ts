import type {
  AgentEvent,
  AgentHatchInput,
  AgentMessage,
  BaseAgent,
} from "../adapter";
import {
  appendAssistantEvents,
  appendProgressEvent,
  appendSimulatorMessage,
  appendTranscriptTurn,
  ensureRunArtifacts,
  readRunMetadata,
  readTranscript,
  readUsage,
  runMetrics,
  updateHeartbeat,
  type MetricResult,
  writeMetricResults,
  writeRunMetadata,
  writeUsage,
} from "../metrics";
import type { Profile } from "../profile";
import type { TestDef } from "../test-def";
import type { TranscriptTurn } from "../transcript";
import { mergeUsageSummaries, summarizeAssistantUsage } from "../usage";
import {
  SimulatorParseError,
  UserSimulator,
} from "../simulator/user-simulator";
import type { Simulator } from "../simulator/types";
import {
  SubprocessFailedError,
  type CommandResult,
} from "../runtime/command-runner";
import { createAgent } from "./create-agent";
import { AgentEventCollector } from "./event-collector";
import type { EvalProgressReporter, EvalProgressStep } from "./progress";

/**
 * Maximum number of stdout/stderr lines from a failed subprocess to
 * inline into the test runner log via `EvalProgressEvent.details`.
 *
 * The full log still lands on disk (`subprocess-<step>.log`) and the
 * report UI renders it inline below the runner log. The runner log
 * itself stays scannable: 30 lines per stream is enough to spot the
 * canonical failure modes (`bind: address already in use`, OOM,
 * compile errors, …) without forcing the operator to scroll through
 * a multi-megabyte image-build log to find the runner summary.
 */
const SUBPROCESS_DETAIL_LINE_CAP = 30;

/**
 * Build the `details` payload for an `EvalProgressEvent` that's
 * bubbling up a `SubprocessFailedError`. The shape is intentionally
 * compact so each entry renders on its own indented line in the
 * console reporter:
 *
 *   exit code: 1
 *   stderr (last 3 lines):
 *     docker: Error response from daemon: ...
 *     bind for 0.0.0.0:20100 failed: port is already allocated
 *   stdout (last 2 lines):
 *     building image vellum-assistant:test
 *     image built in 12s
 *
 * Empty streams collapse to a single `stderr: (empty)` line so the
 * caller can tell the difference between "no output" and "we didn't
 * capture it".
 *
 * Exported for tests.
 */
export function subprocessFailureDetails(err: SubprocessFailedError): string[] {
  const lines: string[] = [`exit code: ${err.result.exitCode}`];
  appendStreamDetails(lines, "stderr", err.result.stderr);
  appendStreamDetails(lines, "stdout", err.result.stdout);
  return lines;
}

function appendStreamDetails(
  lines: string[],
  label: "stdout" | "stderr",
  body: string,
): void {
  const tail = tailNonEmptyLines(body, SUBPROCESS_DETAIL_LINE_CAP);
  if (tail.length === 0) {
    lines.push(`${label}: (empty)`);
    return;
  }
  lines.push(
    `${label} (last ${tail.length} line${tail.length === 1 ? "" : "s"}):`,
  );
  for (const line of tail) lines.push(`  ${line}`);
}

function tailNonEmptyLines(body: string, cap: number): string[] {
  const all = body.split(/\r?\n/);
  // Strip purely-empty entries from the end. Subprocesses commonly
  // emit a trailing newline that produces an empty `""` slot we'd
  // otherwise count toward the cap.
  while (all.length > 0 && all[all.length - 1].length === 0) all.pop();
  if (all.length <= cap) return all;
  return all.slice(-cap);
}

/**
 * Subprocess descriptions baked into the adapter call sites read like
 * `"hatch Vellum profile p1"`, `"setup command for profile p1"`,
 * `"start Hermes container for p1"`, etc. Map the description to the
 * runner step that was in flight so the bubbled-up error lands under
 * the right header. Falls back to the runner's `currentStep` when no
 * keyword matches, which is also the right thing for unrelated
 * errors that happen to land in the same catch.
 */
function inferSubprocessStep(
  description: string,
  fallback: EvalProgressStep,
): EvalProgressStep {
  const lower = description.toLowerCase();
  if (lower.startsWith("hatch") || lower.includes("hermes container"))
    return "hatch";
  if (lower.startsWith("setup")) return "setup";
  if (lower.startsWith("seed conversation") || lower.startsWith("copy seed"))
    return "setup";
  if (lower.startsWith("send")) return "send";
  return fallback;
}

// Re-export so tests can reach the helper without importing
// `command-runner.ts` separately.
export type { CommandResult };

export const EVENT_QUIET_MS = 5_000;
export const EVENT_MAX_MS = 30_000;

export interface EvalRunInput {
  profile: Profile;
  test: TestDef;
  runId: string;
  /** Logical session this execution belongs to. Defaults to the runId itself. */
  sessionId?: string;
  /** Human-readable label propagated from the originating `evals run`. */
  sessionLabel?: string;
  simulator?: Simulator;
  maxTurns?: number;
  progress?: EvalProgressReporter;
}

export interface EvalRunResult {
  runId: string;
  profileId: string;
  testId: string;
  artifactDir: string;
  transcript: TranscriptTurn[];
  metrics: MetricResult[];
}

/** Decimals used when rendering a `fraction`-unit metric score in the CLI log. */
const FRACTION_SCORE_DECIMALS = 2;
/** Decimals used when rendering a `raw`-unit metric score (e.g. dollars) in the CLI log. */
const RAW_SCORE_DECIMALS = 4;

/**
 * Render the per-metric score list as a single-line `name=score, …` string
 * for the `result` progress event's `detail` field. Each metric's unit
 * decides the precision: `fraction` scores get two decimals (matches the
 * 0–1 range humans expect from quality metrics), `raw` scores get four
 * decimals (enough to read sub-cent dollar costs without padding zeros).
 *
 * Returns `"no metrics"` when the test has no metric files configured so
 * the log line still says something rather than dangling an empty suffix.
 */
function formatMetricSummary(metrics: MetricResult[]): string {
  if (metrics.length === 0) return "no metrics";
  return metrics
    .map((m) => {
      const decimals =
        m.unit === "raw" ? RAW_SCORE_DECIMALS : FRACTION_SCORE_DECIMALS;
      return `${m.name}=${m.score.toFixed(decimals)}`;
    })
    .join(", ");
}

/**
 * Pull the text payload an event contributes to the assistant's transcript
 * turn, or `undefined` if the event is not an assistant content event.
 *
 * **Species-specific filtering lives in the adapter, not here.** Each
 * adapter (`adapters/vellum.ts`, `adapters/hermes.ts`) wraps its raw
 * event stream with a normalization step that clears `text` and `chunk`
 * on events that don't carry assistant transcript content (echoes, tool
 * I/O, thinking, errors, usage, …). By the time an event reaches this
 * function, `text` / `chunk` are either set (transcript) or undefined
 * (everything else) — so the getter is a trivial coalesce.
 *
 * Exported for unit-tests; only `collectAndPersistEvents` calls it in
 * production.
 */
export function assistantContent(event: AgentEvent): string | undefined {
  return event.message.text ?? event.message.chunk;
}

export interface CollectAndPersistEventsResult {
  /**
   * Total number of events the collector returned. Zero means the
   * assistant produced no events at all during the quiet/max window —
   * a pipeline failure (no model response, dead event stream, …) that
   * the caller should treat as a hard error.
   */
  eventCount: number;
  /**
   * Number of events that contributed a transcript turn (i.e. carried
   * non-empty `text`/`chunk` after adapter-side normalization).
   * `transcriptTurnCount === 0` with `eventCount > 0` is legitimate:
   * the assistant responded with tool-use-only events that don't have
   * a textual payload.
   */
  transcriptTurnCount: number;
}

/**
 * Collect the next batch of assistant events from the live stream,
 * append them to the cumulative `assistantEvents` array and the on-disk
 * event log, optionally emit transcript turns for events that carry
 * text, and rewrite the persisted usage summary.
 *
 * **The usage write is an overwrite, not a merge.** `input.assistantEvents`
 * is the cumulative-across-turns array (every turn pushes into it),
 * so `summarizeAssistantUsage(input.assistantEvents)` is the complete
 * event-sourced usage state for the run. Merging it with the on-disk
 * value would double-count every prior turn's records (Codex bot +
 * Devin bot caught this on PR #31348; the recording-sidecar usage
 * lands separately via `mergeRecordedUsage` once at end-of-run).
 *
 * Exported for unit-tests; only `runEvalOnce` calls it in production.
 */
export async function collectAndPersistEvents(input: {
  runId: string;
  collector: AgentEventCollector;
  assistantEvents: AgentEvent[];
  includeInTranscript: boolean;
}): Promise<CollectAndPersistEventsResult> {
  const events = await input.collector.collectUntilQuiet({
    quietMs: EVENT_QUIET_MS,
    maxMs: EVENT_MAX_MS,
  });
  input.assistantEvents.push(...events);
  await appendAssistantEvents(input.runId, events);

  let transcriptTurnCount = 0;
  if (input.includeInTranscript) {
    for (const event of events) {
      const content = assistantContent(event);
      if (content?.trim()) {
        await appendTranscriptTurn(input.runId, {
          role: "assistant",
          content: content.trim(),
          emittedAt: event.emittedAt ?? new Date().toISOString(),
        });
        transcriptTurnCount += 1;
      }
    }
  }

  await writeUsage(input.runId, summarizeAssistantUsage(input.assistantEvents));
  return { eventCount: events.length, transcriptTurnCount };
}

async function mergeRecordedUsage(input: {
  runId: string;
  agent: BaseAgent;
}): Promise<void> {
  const records = await input.agent.readUsageRecords?.();
  if (!records || records.length === 0) return;
  const existingUsage = await readUsage(input.runId);
  const recordedUsage = summarizeAssistantUsage(
    records.map((usage) => ({ message: { type: "usage", usage } })),
  );
  await writeUsage(
    input.runId,
    mergeUsageSummaries(existingUsage, recordedUsage),
  );
}

async function sendAndPersistSimulatorMessage(input: {
  runId: string;
  agentSend(message: AgentMessage): Promise<void>;
  message: AgentMessage;
}): Promise<void> {
  await appendSimulatorMessage(input.runId, input.message);
  await appendTranscriptTurn(input.runId, {
    role: "simulator",
    content: input.message.content,
    emittedAt: new Date().toISOString(),
  });
  await input.agentSend(input.message);
}

export async function runEvalOnce(input: EvalRunInput): Promise<EvalRunResult> {
  const sessionId = input.sessionId ?? input.runId;
  const sessionLabel = input.sessionLabel;
  // Wrap the caller's reporter so a buggy reporter (stream write error,
  // throwing custom reporter, etc.) can never interrupt the run — most
  // importantly, it cannot prevent `agent.shutdown()` in the `finally`
  // block from running and leaking a hatched container.
  // Also tee every event to disk so the report server can render the
  // test-runner side of the timeline alongside the container event stream.
  const userProgress = input.progress;
  let currentStep: EvalProgressStep | undefined;
  let currentTurn: number | undefined;
  const progress: EvalProgressReporter = (event) => {
    if (event.status === "start") {
      currentStep = event.step;
      currentTurn = event.turn;
    }
    if (userProgress) {
      try {
        userProgress(event);
      } catch {
        // Progress reporting is best-effort; swallow.
      }
    }
    // Persistence is best-effort; never break a run because the log file
    // could not be appended to.
    void appendProgressEvent(input.runId, {
      ...event,
      emittedAt: new Date().toISOString(),
    }).catch(() => undefined);
    // Update the heartbeat on every progress event to signal that the
    // process is alive. This is best-effort and never blocks the run.
    void updateHeartbeat(input.runId).catch(() => undefined);
  };
  const agentInput: AgentHatchInput = {
    profile: input.profile,
    testId: input.test.id,
    runId: input.runId,
  };
  const agent = createAgent(agentInput);
  const simulator =
    input.simulator ?? new UserSimulator({ maxTurns: input.maxTurns });

  // Per-run heartbeat ticker. Cleared in the `finally` so the timer never
  // outlives a return/throw — and so we never accumulate Node listeners
  // across multiple runs in the same `evals run` invocation (the SIGINT/
  // SIGTERM handlers live one level up in `commands/run.ts` and only
  // register once per process, not once per run).
  const heartbeatInterval = setInterval(() => {
    void updateHeartbeat(input.runId).catch(() => undefined);
  }, 5_000);
  // setInterval would keep the event loop alive past a normal completion
  // because Node treats every active timer as a reason to stay up. Using
  // unref() removes that contribution so a successful run still exits
  // cleanly; clearInterval() in the finally is still the primary stop.
  heartbeatInterval.unref();

  progress({
    step: "artifacts",
    status: "start",
    message: "Preparing run artifacts",
    detail: input.runId,
  });
  const artifacts = await ensureRunArtifacts(input.runId);
  progress({
    step: "artifacts",
    status: "done",
    message: "Run artifacts ready",
    detail: artifacts.runDir,
  });
  const assistantEvents: AgentEvent[] = [];
  const startedAt = new Date().toISOString();
  await writeRunMetadata(input.runId, {
    runId: input.runId,
    sessionId,
    sessionLabel,
    profileId: input.profile.id,
    testId: input.test.id,
    status: "running",
    startedAt,
    artifactDir: artifacts.runDir,
  });

  try {
    progress({
      step: "hatch",
      status: "start",
      message: "Hatching assistant",
      detail: input.profile.id,
    });
    await agent.hatch();
    progress({
      step: "hatch",
      status: "done",
      message: "Assistant ready",
      detail: agent.id,
    });
    for (const [index, command] of input.test.setupCommands.entries()) {
      progress({
        step: "setup",
        status: "start",
        message: `Running setup ${index + 1}/${input.test.setupCommands.length}`,
        detail: command.type,
      });
      await agent.runSetupCommand(command);
      progress({
        step: "setup",
        status: "done",
        message: `Setup ${index + 1}/${input.test.setupCommands.length} complete`,
        detail: command.type,
      });
    }

    progress({
      step: "events",
      status: "start",
      message: "Subscribing to assistant events",
      detail: agent.conversationKey,
    });
    const collector = new AgentEventCollector(
      agent.events()[Symbol.asyncIterator](),
    );
    progress({
      step: "events",
      status: "done",
      message: "Assistant event stream connected",
      detail: agent.conversationKey,
    });

    for (;;) {
      const simulatorTurns = (await readTranscript(input.runId)).filter(
        (turn) => turn.role === "simulator",
      ).length;
      progress({
        step: "simulator",
        status: "start",
        // Turn number is rendered by the reporter as the `turn N` suffix —
        // keeping it out of the message avoids the doubled `turn 2  turn 2`
        // output observed in `eval-vellum-bare-timeline-recall-
        // 20260520135745`.
        message: "Asking simulator",
        turn: simulatorTurns + 1,
      });
      const decision = await simulator.decide({
        test: input.test,
        transcript: await readTranscript(input.runId),
      });
      if (decision.action === "end") {
        progress({
          step: "simulator",
          status: "done",
          message: "Simulator ended the run",
          detail: decision.reason,
          turn: simulatorTurns + 1,
        });
        break;
      }
      progress({
        step: "simulator",
        status: "done",
        message: "Simulator produced the next user message",
        turn: simulatorTurns + 1,
      });

      progress({
        step: "send",
        status: "start",
        message: "Sending simulator message",
        turn: simulatorTurns + 1,
      });
      await sendAndPersistSimulatorMessage({
        runId: input.runId,
        agentSend: (message) => agent.send(message),
        message: decision.message,
      });
      progress({
        step: "send",
        status: "done",
        message: "Simulator message sent",
        turn: simulatorTurns + 1,
      });
      progress({
        step: "events",
        status: "start",
        message: "Waiting for assistant response",
        turn: simulatorTurns + 1,
      });
      const { eventCount, transcriptTurnCount } = await collectAndPersistEvents(
        {
          runId: input.runId,
          collector,
          assistantEvents,
          includeInTranscript: true,
        },
      );
      // A zero-event window means the event stream went silent for the
      // full quiet/max budget without delivering anything — a pipeline
      // failure (dead subscription, model never replied). Throw so the
      // run fails loudly instead of dribbling into metrics with no
      // assistant response.
      //
      // We deliberately do NOT throw on `transcriptTurnCount === 0`
      // alone: tool-use-only responses (assistant emits a tool_use_*
      // event sequence with no `assistant_text_delta`) are legitimate
      // and produce zero transcript turns while still being a real
      // response. Devin caught this regression on PR #31348.
      if (eventCount === 0) {
        throw new Error(
          `assistant response collection produced no events for turn ${simulatorTurns + 1}`,
        );
      }
      progress({
        step: "events",
        status: "done",
        message: "Assistant response collected",
        detail: `${eventCount} event${eventCount === 1 ? "" : "s"} · ${transcriptTurnCount} transcript turn${transcriptTurnCount === 1 ? "" : "s"}`,
        turn: simulatorTurns + 1,
      });
    }

    await mergeRecordedUsage({ runId: input.runId, agent });

    progress({
      step: "metrics",
      status: "start",
      message: "Running metrics",
      detail: `${input.test.metricPaths.length} metric file(s)`,
    });
    const metrics = await runMetrics({ test: input.test, runId: input.runId });
    progress({
      step: "metrics",
      status: "done",
      message: "Metrics complete",
      detail: `${metrics.length} result(s)`,
    });
    await writeMetricResults(input.runId, metrics);
    await writeRunMetadata(input.runId, {
      runId: input.runId,
      sessionId,
      sessionLabel,
      profileId: input.profile.id,
      testId: input.test.id,
      status: "completed",
      startedAt,
      completedAt: new Date().toISOString(),
      artifactDir: artifacts.runDir,
    });
    // Surface the per-metric scores through the progress reporter so the
    // CLI logs them in the same timestamped/labeled format as every other
    // step, instead of dumping a `console.log(JSON.stringify(result))`
    // blob onto stdout. The detail string lists each metric inline so a
    // tail of the eval log immediately shows what the profile achieved.
    progress({
      step: "result",
      status: "done",
      message: `${input.profile.id}/${input.test.id}`,
      detail: formatMetricSummary(metrics),
    });
    return {
      runId: input.runId,
      profileId: input.profile.id,
      testId: input.test.id,
      artifactDir: artifacts.runDir,
      transcript: await readTranscript(input.runId),
      metrics,
    };
  } catch (err) {
    await writeRunMetadata(input.runId, {
      runId: input.runId,
      sessionId,
      sessionLabel,
      profileId: input.profile.id,
      testId: input.test.id,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
      artifactDir: artifacts.runDir,
    });
    // Surface the failure through the progress reporter so operators see a
    // red `✗ <headline>` line under the step that was in flight, with the
    // structured details (stop_reason / parts / body for simulator parse
    // errors; raw err.message for everything else) nested beneath it.
    // Falls back to the simulator step when nothing has started yet — the
    // for-loop simulator turn is by far the most common throw site.
    const failedStep: EvalProgressStep = currentStep ?? "simulator";
    if (err instanceof SimulatorParseError) {
      progress({
        step: failedStep,
        status: "error",
        message: err.headline,
        details: err.details,
        turn: currentTurn,
      });
    } else if (err instanceof SubprocessFailedError) {
      // Bubble subprocess failures up with full structured detail
      // (exit code + last 30 stderr/stdout lines) so the test runner
      // log shows *why* the hatch/setup command failed, not just the
      // single-line `assertSuccess` summary. Re-derives the step from
      // the description because the catch can fire from either the
      // hatch block or the setup loop and `currentStep` only tracks
      // the runner's own lifecycle.
      progress({
        step: inferSubprocessStep(err.description, failedStep),
        status: "error",
        message: `${err.description} failed`,
        details: subprocessFailureDetails(err),
        turn: currentTurn,
      });
    } else {
      progress({
        step: failedStep,
        status: "error",
        message: err instanceof Error ? err.message : String(err),
        turn: currentTurn,
      });
    }
    throw err;
  } finally {
    clearInterval(heartbeatInterval);
    progress({
      step: "shutdown",
      status: "start",
      message: "Shutting down assistant",
      detail: agent.id,
    });
    await agent.shutdown();
    progress({
      step: "shutdown",
      status: "done",
      message: "Assistant shut down",
      detail: agent.id,
    });
    // Verify the run didn't somehow exit "running" by accident.
    const finalMetadata = await readRunMetadata(input.runId);
    if (finalMetadata?.status === "running") {
      await writeRunMetadata(input.runId, {
        ...finalMetadata,
        status: "failed",
        completedAt: new Date().toISOString(),
        error:
          "Run exited without final status — this should never happen; please file a bug.",
      });
    }
  }
}
