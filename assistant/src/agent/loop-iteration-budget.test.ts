/**
 * Verifies the per-run iteration governor the loop applies to unattended
 * (subagent) runs: a one-time wrap-up nudge at the soft threshold, and a
 * graceful stop with the `iteration_budget_reached` exit reason at the hard
 * cap. Drives the REAL loop, mocking only the provider boundary — the same
 * pattern as `loop-exclusive-tool.test.ts`.
 */
import { describe, expect, test } from "bun:test";

import { createMockProvider } from "../__tests__/helpers/mock-provider.js";
import type {
  ContentBlock,
  Message,
  ProviderResponse,
} from "../providers/types.js";
import type { AgentEvent } from "./loop.js";
import { AgentLoop } from "./loop.js";

const NUDGE_MARKER = "ITERATION BUDGET NOTICE";

const endTurn = (text: string): ProviderResponse => ({
  content: [{ type: "text", text }],
  model: "mock-model",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "end_turn",
});

const toolUseTurn = (id: string): ProviderResponse => ({
  content: [
    { type: "text", text: "working" },
    { type: "tool_use", id, name: "noop", input: {} },
  ],
  model: "mock-model",
  usage: { inputTokens: 1, outputTokens: 1 },
  stopReason: "tool_use",
});

/** Count how many text blocks across the history carry the nudge marker. */
function countNudges(history: Message[]): number {
  let count = 0;
  for (const message of history) {
    for (const block of message.content as ContentBlock[]) {
      if (block.type === "text" && block.text.includes(NUDGE_MARKER)) {
        count++;
      }
    }
  }
  return count;
}

function makeLoop(responses: ProviderResponse[], conversationId: string) {
  const { provider, calls } = createMockProvider(responses);
  const loop = new AgentLoop({
    provider,
    systemPrompt: "sys",
    conversationId,
    tools: [
      { name: "noop", description: "", input_schema: { type: "object" } },
    ],
    toolExecutor: async (name) => ({ content: `ran ${name}`, isError: false }),
  });
  return { loop, calls };
}

const baseRun = {
  requestId: "req-budget",
  callSite: "subagentSpawn" as const,
  trust: { sourceChannel: "vellum" as const, trustClass: "unknown" as const },
};

describe("AgentLoop — per-run iteration budget", () => {
  test("injects the wrap-up nudge exactly once when the soft threshold is crossed", async () => {
    // Four tool-use turns then a natural end. Soft nudge at 3 fires after the
    // third call; the run finishes on its own well under the cap.
    const { loop, calls } = makeLoop(
      [
        toolUseTurn("t1"),
        toolUseTurn("t2"),
        toolUseTurn("t3"),
        toolUseTurn("t4"),
        endTurn("done"),
      ],
      "budget-soft",
    );

    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      ...baseRun,
      onEvent: (event) => {
        events.push(event);
      },
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      iterationBudget: { softNudgeAtCalls: 3, maxCallsPerRun: 100 },
    });

    // The nudge appears exactly once, even though two further calls followed it.
    expect(countNudges(history)).toBe(1);
    // The run ended naturally (the model stopped calling tools), not by the cap.
    expect(calls.length).toBe(5);
    const exit = events.find((e) => e.type === "agent_loop_exit");
    expect(exit && exit.type === "agent_loop_exit" && exit.reason).toBe(
      "no_tool_calls",
    );
  });

  test("stops gracefully at the hard cap with the iteration_budget_reached reason", async () => {
    // A provider that always requests a tool would loop forever; the cap stops
    // it. The mock repeats its last scripted response once exhausted.
    const { loop, calls } = makeLoop([toolUseTurn("loop")], "budget-hard");

    const events: AgentEvent[] = [];
    // No throw — a capped run is a normal completion.
    const { history } = await loop.run({
      ...baseRun,
      onEvent: (event) => {
        events.push(event);
      },
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      iterationBudget: { softNudgeAtCalls: 3, maxCallsPerRun: 5 },
    });

    // Exactly `maxCallsPerRun` provider calls were made — no more.
    expect(calls.length).toBe(5);
    // The terminal exit reason marks the budget stop.
    const exit = events.find((e) => e.type === "agent_loop_exit");
    expect(exit && exit.type === "agent_loop_exit" && exit.reason).toBe(
      "iteration_budget_reached",
    );
    // The soft nudge (3 < 5) still fired once on the way to the cap.
    expect(countNudges(history)).toBe(1);
    // The agent's last output is preserved in the returned history.
    expect(
      history.some(
        (m) =>
          m.role === "assistant" &&
          (m.content as ContentBlock[]).some(
            (b) => b.type === "text" && b.text === "working",
          ),
      ),
    ).toBe(true);
  });

  test("leaves a run under the soft threshold untouched", async () => {
    const { loop, calls } = makeLoop(
      [toolUseTurn("t1"), toolUseTurn("t2"), endTurn("done")],
      "budget-under",
    );

    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      ...baseRun,
      onEvent: (event) => {
        events.push(event);
      },
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      iterationBudget: { softNudgeAtCalls: 60, maxCallsPerRun: 100 },
    });

    // No nudge, normal completion, no budget exit.
    expect(countNudges(history)).toBe(0);
    expect(calls.length).toBe(3);
    const exit = events.find((e) => e.type === "agent_loop_exit");
    expect(exit && exit.type === "agent_loop_exit" && exit.reason).toBe(
      "no_tool_calls",
    );
  });

  test("does not govern a run with no iteration budget configured", async () => {
    // Same always-tool provider as the hard-cap test, but with no budget: the
    // script exhausts into a terminating endTurn so the run still ends. The
    // point is that no nudge is injected and no budget exit is emitted.
    const { loop } = makeLoop(
      [toolUseTurn("t1"), toolUseTurn("t2"), endTurn("done")],
      "budget-off",
    );

    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      ...baseRun,
      onEvent: (event) => {
        events.push(event);
      },
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
    });

    expect(countNudges(history)).toBe(0);
    const exit = events.find((e) => e.type === "agent_loop_exit");
    expect(exit && exit.type === "agent_loop_exit" && exit.reason).not.toBe(
      "iteration_budget_reached",
    );
  });

  test("honors a tighter configured cap (governor reads the passed thresholds)", async () => {
    // A cap of 2 proves the loop honors whatever budget it is handed rather
    // than any hardcoded ceiling.
    const { loop, calls } = makeLoop([toolUseTurn("loop")], "budget-custom");

    const events: AgentEvent[] = [];
    await loop.run({
      ...baseRun,
      onEvent: (event) => {
        events.push(event);
      },
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      iterationBudget: { softNudgeAtCalls: 1, maxCallsPerRun: 2 },
    });

    expect(calls.length).toBe(2);
    const exit = events.find((e) => e.type === "agent_loop_exit");
    expect(exit && exit.type === "agent_loop_exit" && exit.reason).toBe(
      "iteration_budget_reached",
    );
  });
});
