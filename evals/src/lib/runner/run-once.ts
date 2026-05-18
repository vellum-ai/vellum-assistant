import type { AgentEvent, AgentMessage } from "../adapter";
import {
  appendAssistantEvents,
  appendProgressEvent,
  appendSimulatorMessage,
  appendTranscriptTurn,
  ensureRunArtifacts,
  readTranscript,
  runMetrics,
  type MetricResult,
  writeMetricResults,
  writeRunMetadata,
  writeUsage,
} from "../metrics";
import type { Profile } from "../profile";
import type { TestDef } from "../test-def";
import type { TranscriptTurn } from "../transcript";
import { summarizeAssistantUsage } from "../usage";
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

function assistantContent(event: AgentEvent): string | undefined {
  const message = event.message;
  return message.text ?? message.content ?? message.message ?? message.chunk;
}

async function collectAndPersistEvents(input: {
  runId: string;
  collector: AgentEventCollector;
  assistantEvents: AgentEvent[];
  includeInTranscript: boolean;
}): Promise<void> {
  const events = await input.collector.collectUntilQuiet({
    quietMs: EVENT_QUIET_MS,
    maxMs: EVENT_MAX_MS,
  });
  input.assistantEvents.push(...events);
  await appendAssistantEvents(input.runId, events);

  if (input.includeInTranscript) {
    for (const event of events) {
      const content = assistantContent(event);
      if (content?.trim()) {
        await appendTranscriptTurn(input.runId, {
          role: "assistant",
          content: content.trim(),
          emittedAt: event.emittedAt ?? new Date().toISOString(),
        });
      }
    }
  }

  await writeUsage(input.runId, summarizeAssistantUsage(input.assistantEvents));
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
        message: `Asking simulator for turn ${simulatorTurns + 1}`,
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
      await collectAndPersistEvents({
        runId: input.runId,
        collector,
        assistantEvents,
        includeInTranscript: true,
      });
      progress({
        step: "events",
        status: "done",
        message: "Assistant response collected",
        turn: simulatorTurns + 1,
      });
    }

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
