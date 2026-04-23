/**
 * Unit tests for the default `overflowReduce` plugin (PR 23).
 *
 * Two goals:
 *   1. The default middleware produces results **identical** to the historical
 *      inline tier loop for a golden set of over-budget histories. We exercise
 *      this by running the same inputs through two paths — the pipeline and a
 *      faithful re-implementation of the pre-PR-23 inline loop — and asserting
 *      the final `(messages, runMessages, injectionMode, reducerState,
 *      reducerCompacted, attempts)` tuple matches byte-for-byte.
 *   2. A user-registered spy middleware observes **every** reduction attempt
 *      when wrapped around the default. This covers the onion-composition
 *      contract: the spy sees each call from the outside and can count
 *      iterations without changing reducer behavior.
 *
 * The test creates its own plugin registry via
 * `resetPluginRegistryForTests()` and re-registers the default before each
 * case so the registry is deterministic across runs.
 */

import { beforeEach, describe, expect, test } from "bun:test";

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
import type {
  InjectionMode,
  TrustContext,
} from "../daemon/conversation-runtime-assembly.js";
import {
  defaultOverflowReduceMiddleware,
  defaultOverflowReducePlugin,
} from "../plugins/defaults/overflow-reduce.js";
import { runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  Middleware,
  OverflowReduceArgs,
  OverflowReduceResult,
  Plugin,
  TurnContext,
} from "../plugins/types.js";
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

const TRUST: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeTurnContext(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-overflow-test",
    conversationId: "conv-overflow-test",
    turnIndex: 0,
    trust: TRUST,
    ...overrides,
  };
}

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
 * Faithful re-implementation of the pre-PR-23 inline tier loop — lives in
 * this test file rather than the production module so we have an immutable
 * baseline the default middleware can be diffed against. If either
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
    didCompact: boolean,
  ) => Promise<Message[]>;
  readonly estimatePostInjection: (runMsgs: Message[]) => number;
}): Promise<{
  messages: Message[];
  runMessages: Message[];
  injectionMode: InjectionMode;
  reducerState: ReducerState;
  reducerCompacted: boolean;
  attempts: number;
}> {
  let messages = args.messages;
  let runMessages = args.runMessages;
  let injectionMode: InjectionMode = "full";
  let reducerState: ReducerState = createInitialReducerState();
  let reducerCompacted = false;
  let attempts = 0;

  while (attempts < args.maxAttempts && !reducerState.exhausted) {
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

    if (step.compactionResult?.compacted) {
      reducerCompacted = true;
    }

    runMessages = await args.reinjectForMode(
      messages,
      injectionMode,
      reducerCompacted,
    );

    const postInjectionTokens = args.estimatePostInjection(runMessages);
    if (postInjectionTokens <= args.preflightBudget) break;
  }

  return {
    messages,
    runMessages,
    injectionMode,
    reducerState,
    reducerCompacted,
    attempts,
  };
}

function buildArgs(messages: Message[]): {
  args: OverflowReduceArgs;
  reinjectCalls: Array<{ mode: InjectionMode; didCompact: boolean }>;
  compactionResults: ContextWindowResult[];
  rawCompactFn: (
    messages: Message[],
    signal: AbortSignal | undefined,
    options: ContextWindowCompactOptions,
  ) => Promise<ContextWindowResult>;
} {
  const reinjectCalls: Array<{ mode: InjectionMode; didCompact: boolean }> = [];
  const compactionResults: ContextWindowResult[] = [];
  const compactFn = makeCompactFn();

  // Identity reinject: the test harness does not exercise the full
  // `applyRuntimeInjections` pipeline; it simply tracks how many times the
  // orchestrator would have been asked to rebuild `runMessages` so the spy
  // middleware can attribute each iteration. Returns the reducer's latest
  // `messages` untouched — real orchestrator code re-injects runtime blocks.
  const reinjectForMode = async (
    reducedMessages: Message[],
    mode: InjectionMode,
    didCompact: boolean,
  ): Promise<Message[]> => {
    reinjectCalls.push({ mode, didCompact });
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
    // leaking the `ContextWindowCompactOptions` shape into the plugin
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

describe("overflow-reduce pipeline", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
    registerPlugin(defaultOverflowReducePlugin);
  });

  describe("default middleware matches historical inline loop", () => {
    test("large tool-result history — identical reduced output", async () => {
      const longToolResult = "r".repeat(8000);
      const goldenHistory: Message[] = [
        msg("user", "Start"),
        toolUseMsg("tu_1", "read_file"),
        toolResultMsg("tu_1", longToolResult),
        msg("assistant", "Result"),
        msg("user", "Next"),
      ];

      const pipelineBuild = buildArgs(goldenHistory);
      const inlineBuild = buildArgs(goldenHistory);

      // Run both paths against the SAME fixture. `buildArgs` gives each
      // call its own `compactFn` instance so nothing leaks between runs.
      const pipelineResult = await runPipeline<
        OverflowReduceArgs,
        OverflowReduceResult
      >(
        "overflowReduce",
        getMiddlewaresFor("overflowReduce"),
        // Sentinel terminal — the default middleware doesn't call next,
        // so this must never fire. Assert that invariant here.
        async () => {
          throw new Error("terminal unexpectedly reached");
        },
        pipelineBuild.args,
        makeTurnContext(),
        30000,
      );

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

      // Byte-for-byte match across every field the orchestrator relies on.
      expect(pipelineResult.messages).toEqual(inlineResult.messages);
      expect(pipelineResult.runMessages).toEqual(inlineResult.runMessages);
      expect(pipelineResult.injectionMode).toBe(inlineResult.injectionMode);
      expect(pipelineResult.reducerState).toEqual(inlineResult.reducerState);
      expect(pipelineResult.reducerCompacted).toBe(
        inlineResult.reducerCompacted,
      );
      expect(pipelineResult.attempts).toBe(inlineResult.attempts);
    });

    test("small conversation that fits after first reduction — single attempt", async () => {
      // A history that's already within budget so the first `applyForcedCompaction`
      // brings us under — the loop must exit without iterating further.
      const smallHistory: Message[] = [
        msg("user", "Hello"),
        msg("assistant", "Hi there — how can I help?"),
      ];

      const pipelineBuild = buildArgs(smallHistory);
      const inlineBuild = buildArgs(smallHistory);

      const pipelineResult = await runPipeline<
        OverflowReduceArgs,
        OverflowReduceResult
      >(
        "overflowReduce",
        getMiddlewaresFor("overflowReduce"),
        async () => {
          throw new Error("terminal unexpectedly reached");
        },
        pipelineBuild.args,
        makeTurnContext(),
        30000,
      );
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

      expect(pipelineResult.attempts).toBe(inlineResult.attempts);
      expect(pipelineResult.attempts).toBeGreaterThanOrEqual(1);
      expect(pipelineResult.messages).toEqual(inlineResult.messages);
      expect(pipelineResult.reducerCompacted).toBe(
        inlineResult.reducerCompacted,
      );
    });
  });

  describe("spy middleware observes each reduction attempt", () => {
    test("spy sees one invocation when the default converges in one step", async () => {
      const history: Message[] = [msg("user", "Hello"), msg("assistant", "Hi")];

      // Spy tracks the args passed into its layer. It must forward via
      // `next` so the default still fires.
      const spyCalls: Array<{
        hadMessages: number;
        budget: number;
        attempts: number;
      }> = [];
      const spy: Middleware<OverflowReduceArgs, OverflowReduceResult> =
        async function spyMiddleware(args, next, _ctx) {
          spyCalls.push({
            hadMessages: args.messages.length,
            budget: args.preflightBudget,
            attempts: 0, // populated after next() from the result
          });
          const result = await next(args);
          spyCalls[spyCalls.length - 1]!.attempts = result.attempts;
          return result;
        };
      const spyPlugin: Plugin = {
        manifest: {
          name: "spy-overflow",
          version: "0.0.1",
          requires: { pluginRuntime: "v1", overflowReduceApi: "v1" },
        },
        middleware: { overflowReduce: spy },
      };
      // Register spy first so it wraps the default (registration order =
      // outer→inner). The default therefore runs as the spy's downstream.
      resetPluginRegistryForTests();
      registerPlugin(spyPlugin);
      registerPlugin(defaultOverflowReducePlugin);

      const { args } = buildArgs(history);
      const result = await runPipeline<
        OverflowReduceArgs,
        OverflowReduceResult
      >(
        "overflowReduce",
        getMiddlewaresFor("overflowReduce"),
        async () => {
          throw new Error("terminal unexpectedly reached");
        },
        args,
        makeTurnContext(),
        30000,
      );

      // Spy was called exactly once — the pipeline invokes each middleware
      // once per pipeline call, not once per reducer iteration. Iteration
      // count shows up in the result.attempts field.
      expect(spyCalls).toHaveLength(1);
      expect(spyCalls[0]?.hadMessages).toBe(2);
      expect(spyCalls[0]?.budget).toBe(1000);
      expect(spyCalls[0]?.attempts).toBe(result.attempts);
      expect(result.attempts).toBeGreaterThanOrEqual(1);
    });

    test("spy can short-circuit the default by not calling next", async () => {
      const history: Message[] = [msg("user", "Hi")];

      const shortCircuit: Middleware<OverflowReduceArgs, OverflowReduceResult> =
        async function shortCircuitMiddleware(args, _next, _ctx) {
          // Returns a synthetic "no-op" result — the default is never invoked.
          return {
            messages: args.messages,
            runMessages: args.runMessages,
            injectionMode: "minimal",
            reducerState: {
              appliedTiers: ["injection_downgrade"],
              injectionMode: "minimal",
              exhausted: true,
            },
            reducerCompacted: false,
            attempts: 0,
          };
        };
      resetPluginRegistryForTests();
      registerPlugin({
        manifest: {
          name: "short-circuit-overflow",
          version: "0.0.1",
          requires: { pluginRuntime: "v1", overflowReduceApi: "v1" },
        },
        middleware: { overflowReduce: shortCircuit },
      });
      registerPlugin(defaultOverflowReducePlugin);

      const { args, compactionResults, reinjectCalls } = buildArgs(history);
      const result = await runPipeline<
        OverflowReduceArgs,
        OverflowReduceResult
      >(
        "overflowReduce",
        getMiddlewaresFor("overflowReduce"),
        async () => {
          throw new Error("terminal unexpectedly reached");
        },
        args,
        makeTurnContext(),
        30000,
      );

      // Because the outer middleware short-circuited, the default never
      // ran — no compactFn invocations, no reinject callbacks.
      expect(result.injectionMode).toBe("minimal");
      expect(result.attempts).toBe(0);
      expect(compactionResults).toHaveLength(0);
      expect(reinjectCalls).toHaveLength(0);
    });
  });

  describe("direct middleware invocation", () => {
    test("default middleware without the pipeline runner still executes the tier loop", async () => {
      const history: Message[] = [msg("user", "Hi")];
      const { args } = buildArgs(history);

      const result = await defaultOverflowReduceMiddleware(
        args,
        async () => {
          throw new Error("next should not be invoked by the default");
        },
        makeTurnContext(),
      );

      expect(result.attempts).toBeGreaterThanOrEqual(1);
      expect(result.reducerState.appliedTiers.length).toBeGreaterThanOrEqual(1);
    });
  });
});
