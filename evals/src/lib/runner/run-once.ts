import type { AgentEvent, AgentMessage } from "../adapter";
import { runMetrics, type MetricResult, type TranscriptTurn } from "../metrics";
import type { Profile } from "../profile";
import type { TestDef } from "../test-def";
import { createAgent } from "./create-agent";
import { HaikuSimulator } from "../simulator/haiku";
import type { Simulator } from "../simulator/types";

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
  transcript: TranscriptTurn[];
  metrics: MetricResult[];
}

function assistantContent(event: AgentEvent): string | undefined {
  const message = event.message;
  return message.text ?? message.content ?? message.message ?? message.chunk;
}

async function collectAvailableEvents(
  agentEvents: AsyncIterator<AgentEvent>,
  timeoutMs: number,
): Promise<AgentEvent[]> {
  const events: AgentEvent[] = [];
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const remaining = deadline - Date.now();
    const next = await Promise.race([
      agentEvents.next(),
      new Promise<IteratorResult<AgentEvent>>((resolve) =>
        setTimeout(
          () => resolve({ done: true, value: undefined }),
          Math.min(remaining, 250),
        ),
      ),
    ]);
    if (next.done) break;
    events.push(next.value);
  }
  return events;
}

export async function runEvalOnce(input: EvalRunInput): Promise<EvalRunResult> {
  const agent = createAgent({
    profile: input.profile,
    testId: input.test.id,
    runId: input.runId,
  });
  const simulator =
    input.simulator ?? new HaikuSimulator({ maxTurns: input.maxTurns });
  const transcript: TranscriptTurn[] = [];
  const simulatorMessages: AgentMessage[] = [];
  const assistantEvents: AgentEvent[] = [];

  await agent.hatch();
  try {
    const eventIterator = agent.events()[Symbol.asyncIterator]();
    for (;;) {
      const decision = await simulator.decide({
        test: input.test,
        assistantEvents,
        transcript: transcript.map(({ role, content }) => ({ role, content })),
      });
      if (decision.action === "end") break;

      simulatorMessages.push(decision.message);
      transcript.push({
        role: "simulator",
        content: decision.message.content,
        emittedAt: new Date().toISOString(),
      });
      await agent.send(decision.message);

      const events = await collectAvailableEvents(
        eventIterator,
        Number(process.env.EVALS_EVENT_SETTLE_MS ?? 5_000),
      );
      assistantEvents.push(...events);
      for (const event of events) {
        const content = assistantContent(event);
        if (content?.trim()) {
          transcript.push({
            role: "assistant",
            content: content.trim(),
            emittedAt: event.emittedAt ?? new Date().toISOString(),
          });
        }
      }
    }

    const metrics = await runMetrics({
      profile: input.profile,
      test: input.test,
      transcript,
      assistantEvents,
      simulatorMessages,
    });
    return {
      runId: input.runId,
      profileId: input.profile.id,
      testId: input.test.id,
      transcript,
      metrics,
    };
  } finally {
    await agent.shutdown();
  }
}
