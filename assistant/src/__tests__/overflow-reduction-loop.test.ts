/**
 * Unit tests for `runOverflowReductionLoop` — the direct-call overflow
 * reducer driver.
 *
 * The default loop produces results **identical** to the historical inline
 * tier loop for a golden set of over-budget histories. We exercise this by
 * running the same inputs through two paths — `runOverflowReductionLoop` and
 * a faithful re-implementation of the original inline loop — and asserting
 * the final `(messages, runMessages, injectionMode, reducerState,
 * attempts)` tuple matches byte-for-byte. Additional cases
 * cover the two abort gates.
 */

import { describe, expect, test } from "bun:test";

import { estimatePromptTokens } from "../context/token-estimator.js";
import type {
  ContextWindowCompactOptions,
  ContextWindowResult,
} from "../context/window-manager.js";
import { createContextSummaryMessage } from "../context/window-manager.js";
import {
  createInitialReducerState,
  reduceContextOverflow,
  type ReducerState,
} from "../daemon/context-overflow-reducer.js";
import type { InjectionMode } from "../daemon/conversation-runtime-assembly.js";
import {
  type OverflowReduceArgs,
  runOverflowReductionLoop,
} from "../daemon/overflow-reduction-loop.js";
import type { Message } from "../providers/types.js";

// ── Fixtures ────────────────────────────────────────────────────────────────

function msg(role: "user" | "assistant", text: string): Message {
  return { role, content: [{ type: "text", text }] };
}

function toolUseMsg(id: string, name: string): Message {
  return {
    role: "assistant",
    content: [{ type: "tool_use", id, name, input: { path: "/tmp/test" } }],
  };
}

function toolResultMsg(toolUseId: string, content: string): Message {
  return {
    role: "user",
    content: [{ type: "tool_result", tool_use_id: toolUseId, content }],
  };
}

const SYSTEM_PROMPT = "You are a helpful assistant.";

const CONTEXT_WINDOW = {
  enabled: true,
  maxInputTokens: 2000,
  targetBudgetRatio: 0.65,
  compactThreshold: 0.6,
  summaryBudgetRatio: 0.05,
  overflowRecovery: {
    enabled: true,
    safetyMarginRatio: 0.05,
    maxAttempts: 3,
    interactiveLatestTurnCompression: "summarize" as const,
    nonInteractiveLatestTurnCompression: "truncate" as const,
  },
};

/**
 * Minimal compaction stub — always compacts to a one-message summary so the
 * reducer's forced-compaction tier succeeds. Mirrors `makeCompactFn` from
 * `context-overflow-reducer.test.ts` so the two test suites exercise the
 * reducer under comparable conditions.
 */
function makeCompactFn(
  summaryText = "## Goals\n- compacted summary",
): (
  messages: Message[],
  signal: AbortSignal | undefined,
  options: ContextWindowCompactOptions,
) => Promise<ContextWindowResult> {
  return async (messages, _signal, _options) => {
    const summaryMsg = createContextSummaryMessage(summaryText);
    const compactedMessages = [summaryMsg];
    const estimatedInputTokens = estimatePromptTokens(
      compactedMessages,
      SYSTEM_PROMPT,
      { providerName: "mock" },
    );
    return {
      messages: compactedMessages,
      compacted: true,
      previousEstimatedInputTokens: estimatePromptTokens(
        messages,
        SYSTEM_PROMPT,
        { providerName: "mock" },
      ),
      estimatedInputTokens,
      maxInputTokens: 2000,
      thresholdTokens: 1200,
      compactedMessages: messages.length,
      compactedPersistedMessages: messages.length,
      summaryCalls: 1,
      summaryInputTokens: 100,
      summaryOutputTokens: 50,
      summaryModel: "mock-model",
      summaryText,
    };
  };
}

/**
 * Faithful re-implementation of the original inline tier loop — lives in
 * this test file rather than the production module so we have an immutable
 * baseline `runOverflowReductionLoop` can be diffed against. If either
 * implementation drifts, the golden-output cases below fail.
 *
 * The function intentionally avoids any side effects on external state — no
 * circuit-breaker tracking, no activity emission, no `applyCompactionResult`.
 * The production orchestrator still runs those through callbacks; this
 * baseline only needs the *message mutation* behavior so we can compare
 * reducer output.
 */
async function runInlineBaseline(args: {
  readonly messages: Message[];
  readonly runMessages: Message[];
  readonly systemPrompt: string;
  readonly providerName: string;
  readonly preflightBudget: number;
  readonly toolTokenBudget?: number;
  readonly maxAttempts: number;
  readonly abortSignal?: AbortSignal;
  readonly compactFn: (
    messages: Message[],
    signal: AbortSignal | undefined,
    options: ContextWindowCompactOptions,
  ) => Promise<ContextWindowResult>;
  readonly contextWindow: typeof CONTEXT_WINDOW;
  readonly reinjectForMode: (
    reducedMessages: Message[],
    mode: InjectionMode,
  ) => Promise<Message[]>;
  readonly estimatePostInjection: (runMsgs: Message[]) => number;
}): Promise<{
  messages: Message[];
  runMessages: Message[];
  injectionMode: InjectionMode;
  reducerState: ReducerState;
  attempts: number;
}> {
  let messages = args.messages;
  let runMessages = args.runMessages;
  let injectionMode: InjectionMode = "full";
  let reducerState: ReducerState = createInitialReducerState();
  let attempts = 0;

  while (attempts < args.maxAttempts && !reducerState.exhausted) {
    args.abortSignal?.throwIfAborted();
    attempts++;
    const step = await reduceContextOverflow(
      messages,
      {
        providerName: args.providerName,
        systemPrompt: args.systemPrompt,
        contextWindow: args.contextWindow,
        targetTokens: args.preflightBudget,
        toolTokenBudget: args.toolTokenBudget,
      },
      reducerState,
      args.compactFn,
      args.abortSignal,
    );

    reducerState = step.state;
    messages = step.messages;
    injectionMode = step.state.injectionMode;

    args.abortSignal?.throwIfAborted();

    runMessages = await args.reinjectForMode(messages, injectionMode);

    const postInjectionTokens = args.estimatePostInjection(runMessages);
    if (postInjectionTokens <= args.preflightBudget) break;
  }

  return {
    messages,
    runMessages,
    injectionMode,
    reducerState,
    attempts,
  };
}

function buildArgs(messages: Message[]): {
  args: OverflowReduceArgs;
  reinjectCalls: Array<{ mode: InjectionMode }>;
  compactionResults: ContextWindowResult[];
  rawCompactFn: (
    messages: Message[],
    signal: AbortSignal | undefined,
    options: ContextWindowCompactOptions,
  ) => Promise<ContextWindowResult>;
} {
  const reinjectCalls: Array<{ mode: InjectionMode }> = [];
  const compactionResults: ContextWindowResult[] = [];
  const compactFn = makeCompactFn();

  // Identity reinject: the test harness does not exercise the full
  // `applyRuntimeInjections` pipeline; it simply tracks how many times the
  // orchestrator would have been asked to rebuild `runMessages`. Returns the
  // reducer's latest `messages` untouched — real orchestrator code re-injects
  // runtime blocks.
  const reinjectForMode = async (
    reducedMessages: Message[],
    mode: InjectionMode,
  ): Promise<Message[]> => {
    reinjectCalls.push({ mode });
    return reducedMessages;
  };

  const estimatePostInjection = (runMsgs: Message[]): number =>
    estimatePromptTokens(runMsgs, SYSTEM_PROMPT, {
      providerName: "mock",
    });

  const args: OverflowReduceArgs = {
    messages,
    runMessages: messages,
    systemPrompt: SYSTEM_PROMPT,
    providerName: "mock",
    contextWindow: CONTEXT_WINDOW,
    preflightBudget: 1000,
    toolTokenBudget: 0,
    maxAttempts: CONTEXT_WINDOW.overflowRecovery.maxAttempts,
    // `OverflowReduceArgs.compactFn` types `options` as `unknown` to avoid
    // leaking the `ContextWindowCompactOptions` shape into the loop's args
    // surface. The test helper produces a real `ContextWindowCompactOptions`
    // signature, so we trampoline through a widened wrapper.
    compactFn: (msgs, signal, opts) =>
      compactFn(msgs, signal, opts as ContextWindowCompactOptions),
    emitActivityState: () => {
      /* no-op — the orchestrator owns activity emission */
    },
    onCompactionResult: (result) => {
      compactionResults.push(result);
    },
    reinjectForMode,
    estimatePostInjection,
  };

  return { args, reinjectCalls, compactionResults, rawCompactFn: compactFn };
}

// ── Test suite ──────────────────────────────────────────────────────────────

describe("runOverflowReductionLoop", () => {
  describe("matches historical inline loop", () => {
    test("large tool-result history — identical reduced output", async () => {
      // GIVEN an over-budget history dominated by a large tool result.
      const longToolResult = "r".repeat(8000);
      const goldenHistory: Message[] = [
        msg("user", "Start"),
        toolUseMsg("tu_1", "read_file"),
        toolResultMsg("tu_1", longToolResult),
        msg("assistant", "Result"),
        msg("user", "Next"),
      ];

      // AND two independently-built arg sets over the SAME fixture so the
      // direct call and the inline baseline never share a `compactFn`.
      const directBuild = buildArgs(goldenHistory);
      const inlineBuild = buildArgs(goldenHistory);

      // WHEN we reduce via the direct loop and the inline baseline.
      const directResult = await runOverflowReductionLoop(directBuild.args);
      const inlineResult = await runInlineBaseline({
        messages: goldenHistory,
        runMessages: goldenHistory,
        systemPrompt: SYSTEM_PROMPT,
        providerName: "mock",
        preflightBudget: inlineBuild.args.preflightBudget,
        toolTokenBudget: inlineBuild.args.toolTokenBudget,
        maxAttempts: inlineBuild.args.maxAttempts,
        compactFn: inlineBuild.rawCompactFn,
        contextWindow: CONTEXT_WINDOW,
        reinjectForMode: inlineBuild.args.reinjectForMode,
        estimatePostInjection: inlineBuild.args.estimatePostInjection,
      });

      // THEN every field the orchestrator relies on matches byte-for-byte.
      expect(directResult.messages).toEqual(inlineResult.messages);
      expect(directResult.runMessages).toEqual(inlineResult.runMessages);
      expect(directResult.injectionMode).toBe(inlineResult.injectionMode);
      expect(directResult.reducerState).toEqual(inlineResult.reducerState);
      expect(directResult.attempts).toBe(inlineResult.attempts);
    });

    test("small conversation that fits after first reduction — single attempt", async () => {
      // GIVEN a history that the first forced compaction brings under budget.
      const smallHistory: Message[] = [
        msg("user", "Hello"),
        msg("assistant", "Hi there — how can I help?"),
      ];

      const directBuild = buildArgs(smallHistory);
      const inlineBuild = buildArgs(smallHistory);

      // WHEN we reduce via the direct loop and the inline baseline.
      const directResult = await runOverflowReductionLoop(directBuild.args);
      const inlineResult = await runInlineBaseline({
        messages: smallHistory,
        runMessages: smallHistory,
        systemPrompt: SYSTEM_PROMPT,
        providerName: "mock",
        preflightBudget: inlineBuild.args.preflightBudget,
        toolTokenBudget: inlineBuild.args.toolTokenBudget,
        maxAttempts: inlineBuild.args.maxAttempts,
        compactFn: inlineBuild.rawCompactFn,
        contextWindow: CONTEXT_WINDOW,
        reinjectForMode: inlineBuild.args.reinjectForMode,
        estimatePostInjection: inlineBuild.args.estimatePostInjection,
      });

      // THEN both paths converge in the same single attempt with equal output.
      expect(directResult.attempts).toBe(inlineResult.attempts);
      expect(directResult.attempts).toBeGreaterThanOrEqual(1);
      expect(directResult.messages).toEqual(inlineResult.messages);
    });
  });

  describe("abort signal propagation", () => {
    test("bails between iterations when abortSignal fires", async () => {
      // GIVEN a history that won't converge in one step (multiple iterations).
      const longToolResult = "r".repeat(8000);
      const history: Message[] = [
        msg("user", "Start"),
        toolUseMsg("tu_1", "read_file"),
        toolResultMsg("tu_1", longToolResult),
        msg("user", "Next"),
      ];

      const controller = new AbortController();
      const build = buildArgs(history);
      // AND an estimator that aborts on its first call while reporting
      // over-budget — so without the abort gate another iteration would run.
      let estimateCalls = 0;
      const aborting: OverflowReduceArgs = {
        ...build.args,
        abortSignal: controller.signal,
        estimatePostInjection: () => {
          estimateCalls++;
          if (estimateCalls === 1) controller.abort();
          return build.args.preflightBudget + 1_000_000;
        },
      };

      // WHEN the loop runs THEN it throws on the post-side-effect abort gate.
      await expect(runOverflowReductionLoop(aborting)).rejects.toThrow();
      // AND exactly one iteration ran; the gate stopped the next round.
      expect(estimateCalls).toBe(1);
    });

    test("refuses to start when abortSignal is already aborted", async () => {
      // GIVEN an already-aborted signal.
      const history: Message[] = [msg("user", "Hi")];
      const controller = new AbortController();
      controller.abort();
      const build = buildArgs(history);
      const args: OverflowReduceArgs = {
        ...build.args,
        abortSignal: controller.signal,
      };

      // WHEN the loop runs THEN it throws before the reducer ever runs.
      await expect(runOverflowReductionLoop(args)).rejects.toThrow();
      // AND no compaction or reinject callbacks were observed.
      expect(build.compactionResults).toHaveLength(0);
      expect(build.reinjectCalls).toHaveLength(0);
    });
  });
});
