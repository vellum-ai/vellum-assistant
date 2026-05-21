import type { AgentEvent, AgentMessage, BaseAgent } from "../adapter";
import {
  appendAssistantEvents,
  appendProgressEvent,
  appendSimulatorMessage,
  appendTranscriptTurn,
  ensureRunArtifacts,
  readTranscript,
  readUsage,
  runMetrics,
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
import { createAgent } from "./create-agent";
import { AgentEventCollector } from "./event-collector";
import type { EvalProgressReporter, EvalProgressStep } from "./progress";

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

async function collectAndPersistEvents(input: {
  runId: string;
  collector: AgentEventCollector;
  assistantEvents: AgentEvent[];
  includeInTranscript: boolean;
}): Promise<number> {
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

  const eventUsage = summarizeAssistantUsage(input.assistantEvents);
  const existingUsage = await readUsage(input.runId);
  await writeUsage(input.runId, mergeUsageSummaries(existingUsage, eventUsage));
  return transcriptTurnCount;
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
  };
  const agent = createAgent({
    profile: input.profile,
    testId: input.test.id,
    runId: input.runId,
  });
  const simulator =
    input.simulator ?? new UserSimulator({ maxTurns: input.maxTurns });
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
  try {
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
      const assistantTranscriptTurns = await collectAndPersistEvents({
        runId: input.runId,
        collector,
        assistantEvents,
        includeInTranscript: true,
      });
      if (assistantTranscriptTurns === 0) {
        throw new Error(
          `assistant response collection produced no transcript text for turn ${simulatorTurns + 1}`,
        );
      }
      progress({
        step: "events",
        status: "done",
        message: "Assistant response collected",
        detail: `${assistantTranscriptTurns} transcript turn${assistantTranscriptTurns === 1 ? "" : "s"}`,
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
  }
}
