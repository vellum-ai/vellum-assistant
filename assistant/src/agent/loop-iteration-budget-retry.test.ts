/**
 * The iteration-budget hard cap is evaluated at the top of each loop iteration,
 * before the provider call. A retryable failure of the cap-th provider call
 * (context-overflow reduction or a post-model-call history repair) re-enters the
 * loop to recover — but its `llm_call_started` row is still pending and its real
 * error is unresolved. If the cap fired at that re-entry it would strand the
 * empty row and swallow the error as a clean `iteration_budget_reached`.
 *
 * These tests drive the REAL loop (mocking only the provider boundary) and prove
 * the cap bounds NEW work only: a pending retry runs first, then either the run
 * completes / the cap stops cleanly, or the failure surfaces as the failure it
 * is. The overflow path reuses the capturing-manager harness from
 * `agent-loop-compaction-strip.test.ts`; the repair path registers a
 * post-model-call recovery hook.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";

import type { ScriptedResponse } from "../__tests__/helpers/mock-provider.js";
import { createMockProvider } from "../__tests__/helpers/mock-provider.js";
import type { ContextWindowConfig } from "../config/types.js";
import { HOOKS } from "../plugin-api/constants.js";
import type { PostModelCallContext } from "../plugin-api/types.js";
import {
  createContextWindowManager,
  disposeContextWindowManager,
  getContextWindowManager,
} from "../plugins/defaults/compaction/manager-store.js";
import {
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  ContentBlock,
  Message,
  Provider,
  ProviderResponse,
} from "../providers/types.js";
import { ContextOverflowError } from "../providers/types.js";
import type { AgentEvent } from "./loop.js";
import { AgentLoop } from "./loop.js";

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

const overflowError = (): ContextOverflowError =>
  new ContextOverflowError("prompt too long", "mock", {
    actualTokens: 999_999,
  });

function makeLoop(responses: ScriptedResponse[], conversationId: string) {
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
  requestId: "req-budget-retry",
  callSite: "subagentSpawn" as const,
  trust: { sourceChannel: "vellum" as const, trustClass: "unknown" as const },
};

/** Options that arm the loop's overflow-recovery ladder. */
const overflowRun = {
  modelProfileKey: "balanced",
  compactInPlace: false as const,
  resolveContextWindow: () => ({
    maxInputTokens: 10,
    overflowRecovery: { enabled: true, safetyMarginRatio: 0 },
  }),
};

/**
 * Register a per-conversation manager whose `recoverContextOverflow` returns the
 * history unchanged and reports the given `exhausted` state, so the loop's
 * overflow branch can drive without real summarization. Records how many times
 * recovery ran.
 */
function installRecoveryManager(
  conversationId: string,
  opts: { exhausted: boolean },
): { recoveryCount: () => number } {
  createContextWindowManager({
    provider: { name: "mock-provider" } as unknown as Provider,
    config: {} as unknown as ContextWindowConfig,
    conversationId,
  });
  const manager = getContextWindowManager(conversationId);
  let recoveries = 0;
  if (manager) {
    manager.recoverContextOverflow = (async (messages: Message[]) => {
      recoveries += 1;
      return { messages, compacted: true, exhausted: opts.exhausted };
    }) as unknown as typeof manager.recoverContextOverflow;
  }
  return { recoveryCount: () => recoveries };
}

function exitReasonOf(events: AgentEvent[]): string | undefined {
  const exit = events.find((e) => e.type === "agent_loop_exit");
  return exit && exit.type === "agent_loop_exit" ? exit.reason : undefined;
}

function historyHasAssistantText(history: Message[], text: string): boolean {
  return history.some(
    (m) =>
      m.role === "assistant" &&
      (m.content as ContentBlock[]).some(
        (b) => b.type === "text" && b.text === text,
      ),
  );
}

describe("AgentLoop — iteration budget vs. retryable failure at the cap", () => {
  beforeEach(() => {
    // Isolate from any globally-registered plugin hooks; the loop's compaction
    // re-injection and tool-result hooks fail open when none are present.
    resetPluginRegistryForTests();
  });
  afterEach(() => {
    disposeContextWindowManager("overflow-recover");
    disposeContextWindowManager("overflow-exhausted");
    resetPluginRegistryForTests();
  });

  test("an overflow rejection AT the cap runs its recovery, then the cap stops cleanly", async () => {
    // maxCallsPerRun = 2. Call 1 is a tool turn; call 2 (the cap-th) is
    // rejected as context-too-large; the recovery re-issues as call 3 (a tool
    // turn that completes). The cap then stops at the next clean boundary.
    const conversationId = "overflow-recover";
    const { loop, calls } = makeLoop(
      [
        toolUseTurn("t1"),
        overflowError(),
        toolUseTurn("t2"),
        toolUseTurn("t3"),
      ],
      conversationId,
    );
    const recovery = installRecoveryManager(conversationId, {
      exhausted: false,
    });

    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      ...baseRun,
      ...overflowRun,
      onEvent: (event) => {
        events.push(event);
      },
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      iterationBudget: { softNudgeAtCalls: 10, maxCallsPerRun: 2 },
    });

    // The recovery ran once and the re-issued call (call 3) was actually made —
    // the cap did NOT truncate the in-flight recovery.
    expect(recovery.recoveryCount()).toBe(1);
    expect(calls.length).toBe(3);
    // The recovered call's assistant output is finalized in history, not stranded.
    expect(historyHasAssistantText(history, "working")).toBe(true);
    // The overflow was recovered, not surfaced as a hard error.
    expect(events.some((e) => e.type === "error")).toBe(false);
    // Only after the recovery completed did the cap stop the run — cleanly.
    expect(exitReasonOf(events)).toBe("iteration_budget_reached");
  });

  test("an UNRECOVERABLE overflow at the cap surfaces as the failure, not a clean budget stop", async () => {
    // The recovery ladder is exhausted, so the re-issued call (call 3) rejects
    // again with no rung left. The loop must surface the overflow as the
    // terminal it is — NOT convert it into `iteration_budget_reached`.
    const conversationId = "overflow-exhausted";
    const { loop, calls } = makeLoop(
      [toolUseTurn("t1"), overflowError(), overflowError()],
      conversationId,
    );
    const recovery = installRecoveryManager(conversationId, {
      exhausted: true,
    });

    const events: AgentEvent[] = [];
    await loop.run({
      ...baseRun,
      ...overflowRun,
      onEvent: (event) => {
        events.push(event);
      },
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      iterationBudget: { softNudgeAtCalls: 10, maxCallsPerRun: 2 },
    });

    // Recovery was attempted and the retry (call 3) was made past the cap...
    expect(recovery.recoveryCount()).toBe(1);
    expect(calls.length).toBe(3);
    // ...and the real overflow failure surfaces as its own terminal — the cap
    // did not swallow it into a clean `iteration_budget_reached`.
    expect(exitReasonOf(events)).toBe("context_too_large");
    // Each rejected provider call was logged as a provider_error, not hidden.
    expect(events.filter((e) => e.type === "provider_error").length).toBe(2);
  });
});

describe("AgentLoop — iteration budget vs. post-model-call repair at the cap", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });
  afterEach(() => {
    resetPluginRegistryForTests();
  });

  test("a post-model-call repair AT the cap runs its retry to completion", async () => {
    // A hook that, on a provider rejection, repairs the history and asks the
    // loop to retry. maxCallsPerRun = 2: call 1 is a tool turn, call 2 (the
    // cap-th) is a plain rejection the hook recovers, and call 3 completes.
    registerPlugin({
      manifest: { name: "test-repair", version: "0.0.0" },
      hooks: {
        [HOOKS.POST_MODEL_CALL]: async (ctx: PostModelCallContext) => {
          // Only act on a provider rejection; finalized replies pass through.
          if (ctx.error) {
            ctx.decision = "continue";
            ctx.messages = [...ctx.messages];
          }
        },
      },
    });

    const conversationId = "repair-at-cap";
    const { loop, calls } = makeLoop(
      [
        toolUseTurn("t1"),
        new Error("transient provider rejection"),
        endTurn("recovered and done"),
      ],
      conversationId,
    );

    const events: AgentEvent[] = [];
    const { history } = await loop.run({
      ...baseRun,
      onEvent: (event) => {
        events.push(event);
      },
      messages: [{ role: "user", content: [{ type: "text", text: "go" }] }],
      iterationBudget: { softNudgeAtCalls: 10, maxCallsPerRun: 2 },
    });

    // The repaired retry (call 3) was actually issued — the cap did not stop the
    // run at the pending, unfinalized failed call.
    expect(calls.length).toBe(3);
    // The run reached a genuine completion, not a swallowed budget stop.
    expect(exitReasonOf(events)).toBe("no_tool_calls");
    expect(historyHasAssistantText(history, "recovered and done")).toBe(true);
    // The rejection was recovered, so no terminal error surfaced.
    expect(events.some((e) => e.type === "error")).toBe(false);
  });
});
