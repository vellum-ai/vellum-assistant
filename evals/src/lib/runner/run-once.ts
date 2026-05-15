import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { AgentEvent, AgentMessage } from "../adapter";
import {
  createMetricContext,
  metricArtifactPaths,
  runMetrics,
  type MetricResult,
  writeMetricArtifacts,
} from "../metrics";
import type { Profile } from "../profile";
import type { TestDef } from "../test-def";
import type { TranscriptTurn } from "../transcript";
import { summarizeAssistantUsage } from "../usage";
import { UserSimulator } from "../simulator/user-simulator";
import type { Simulator } from "../simulator/types";
import { createAgent } from "./create-agent";
import { AgentEventCollector } from "./event-collector";

export interface EvalRunInput {
  profile: Profile;
  test: TestDef;
  runId: string;
  simulator?: Simulator;
  maxTurns?: number;
  artifactDir?: string;
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

function defaultArtifactDir(runId: string): string {
  return join(process.env.EVALS_RUNS_DIR ?? ".eval-runs", runId);
}

function settleMs(): number {
  return Number(process.env.EVALS_EVENT_SETTLE_MS ?? 5_000);
}

function maxEventCollectionMs(): number {
  return Number(process.env.EVALS_EVENT_MAX_MS ?? settleMs() * 6);
}

async function appendEventsToTranscript(input: {
  collector: AgentEventCollector;
  assistantEvents: AgentEvent[];
  transcript: TranscriptTurn[];
  phase: "setup" | "eval";
}): Promise<void> {
  const events = await input.collector.collectUntilQuiet({
    quietMs: settleMs(),
    maxMs: maxEventCollectionMs(),
  });
  input.assistantEvents.push(...events);
  for (const event of events) {
    const content = assistantContent(event);
    if (content?.trim()) {
      input.transcript.push({
        role: "assistant",
        content: content.trim(),
        emittedAt: event.emittedAt ?? new Date().toISOString(),
        phase: input.phase,
      });
    }
  }
}

export async function runEvalOnce(input: EvalRunInput): Promise<EvalRunResult> {
  const agent = createAgent({
    profile: input.profile,
    testId: input.test.id,
    runId: input.runId,
  });
  const simulator =
    input.simulator ?? new UserSimulator({ maxTurns: input.maxTurns });
  const artifactDir = input.artifactDir ?? defaultArtifactDir(input.runId);
  const transcript: TranscriptTurn[] = [];
  const simulatorMessages: AgentMessage[] = [];
  const assistantEvents: AgentEvent[] = [];

  await mkdir(artifactDir, { recursive: true });
  await agent.hatch();
  try {
    const collector = new AgentEventCollector(
      agent.events()[Symbol.asyncIterator](),
    );

    for (const message of input.test.setupMessages) {
      simulatorMessages.push(message);
      transcript.push({
        role: "simulator",
        content: message.content,
        emittedAt: new Date().toISOString(),
        phase: "setup",
      });
      await agent.send(message);
      await appendEventsToTranscript({
        collector,
        assistantEvents,
        transcript,
        phase: "setup",
      });
    }

    for (;;) {
      const decision = await simulator.decide({
        test: input.test,
        transcript,
      });
      if (decision.action === "end") break;

      simulatorMessages.push(decision.message);
      transcript.push({
        role: "simulator",
        content: decision.message.content,
        emittedAt: new Date().toISOString(),
        phase: "eval",
      });
      await agent.send(decision.message);
      await appendEventsToTranscript({
        collector,
        assistantEvents,
        transcript,
        phase: "eval",
      });
    }

    const usage = summarizeAssistantUsage(assistantEvents);
    const artifacts = metricArtifactPaths(artifactDir);
    await writeMetricArtifacts(artifacts, {
      transcript,
      assistantEvents,
      simulatorMessages,
      usage,
    });

    const metrics = await runMetrics(
      createMetricContext({
        profile: input.profile,
        test: input.test,
        runId: input.runId,
        artifactDir,
      }),
    );
    return {
      runId: input.runId,
      profileId: input.profile.id,
      testId: input.test.id,
      artifactDir,
      transcript,
      metrics,
    };
  } finally {
    await agent.shutdown();
  }
}
