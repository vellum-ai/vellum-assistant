import type { AgentEvent, AgentMessage } from "../adapter";
import {
  appendAssistantEvents,
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
import { UserSimulator } from "../simulator/user-simulator";
import type { Simulator } from "../simulator/types";
import { createAgent } from "./create-agent";
import { AgentEventCollector } from "./event-collector";

export const EVENT_QUIET_MS = 5_000;
export const EVENT_MAX_MS = 30_000;

export interface EvalRunInput {
  profile: Profile;
  test: TestDef;
  runId: string;
  simulator?: Simulator;
  maxTurns?: number;
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
  const agent = createAgent({
    profile: input.profile,
    testId: input.test.id,
    runId: input.runId,
  });
  const simulator =
    input.simulator ?? new UserSimulator({ maxTurns: input.maxTurns });
  const artifacts = await ensureRunArtifacts(input.runId);
  const assistantEvents: AgentEvent[] = [];
  const startedAt = new Date().toISOString();
  await writeRunMetadata(input.runId, {
    runId: input.runId,
    profileId: input.profile.id,
    testId: input.test.id,
    status: "running",
    startedAt,
    artifactDir: artifacts.runDir,
  });

  await agent.hatch();
  try {
    for (const command of input.test.setupCommands) {
      await agent.runSetupCommand(command);
    }

    const collector = new AgentEventCollector(
      agent.events()[Symbol.asyncIterator](),
    );

    for (;;) {
      const decision = await simulator.decide({
        test: input.test,
        transcript: await readTranscript(input.runId),
      });
      if (decision.action === "end") break;

      await sendAndPersistSimulatorMessage({
        runId: input.runId,
        agentSend: (message) => agent.send(message),
        message: decision.message,
      });
      await collectAndPersistEvents({
        runId: input.runId,
        collector,
        assistantEvents,
        includeInTranscript: true,
      });
    }

    const metrics = await runMetrics({ test: input.test, runId: input.runId });
    await writeMetricResults(input.runId, metrics);
    await writeRunMetadata(input.runId, {
      runId: input.runId,
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
      profileId: input.profile.id,
      testId: input.test.id,
      status: "failed",
      startedAt,
      completedAt: new Date().toISOString(),
      error: err instanceof Error ? err.message : String(err),
      artifactDir: artifacts.runDir,
    });
    throw err;
  } finally {
    await agent.shutdown();
  }
}
