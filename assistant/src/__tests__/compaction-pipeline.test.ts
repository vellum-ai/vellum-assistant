/**
 * Tests for the `compaction` plugin pipeline (PR 25).
 *
 * Covers:
 * - Default plugin delegates to the manager's `maybeCompact` and returns the
 *   same `ContextWindowResult` object the manager produced.
 * - A custom plugin layered on top can short-circuit before the terminal is
 *   reached and return a different summary, demonstrating that the pipeline
 *   slot is observable and replaceable without patching the manager.
 *
 * The tests drive `runPipeline` directly rather than going through the full
 * orchestrator — the integration path (conversation-agent-loop) is exercised
 * by `conversation-agent-loop-overflow.test.ts`, which must continue to pass
 * as the acceptance criterion for this PR.
 */

import { describe, expect, test } from "bun:test";

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import {
  DEFAULT_COMPACTION_PLUGIN_NAME,
  defaultCompactionTerminal,
} from "../plugins/defaults/compaction.js";
import { runPipeline } from "../plugins/pipeline.js";
import {
  type CompactionArgs,
  type CompactionResult,
  type Middleware,
  PluginExecutionError,
  type TurnContext,
} from "../plugins/types.js";

type ContextWindowResultShape = {
  compacted: boolean;
  summaryText: string;
  messages: unknown[];
  previousEstimatedInputTokens: number;
  estimatedInputTokens: number;
  maxInputTokens: number;
  thresholdTokens: number;
  compactedMessages: number;
  compactedPersistedMessages: number;
  summaryCalls: number;
  summaryInputTokens: number;
  summaryOutputTokens: number;
  summaryModel: string;
  reason?: string;
};

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeTurnCtx(manager: {
  maybeCompact: (...args: unknown[]) => Promise<unknown>;
}): TurnContext {
  return {
    requestId: "req-compaction-test",
    conversationId: "conv-compaction-test",
    turnIndex: 0,
    trust,
    // `TurnContext.contextWindowManager` is a typed optional field; the
    // default compaction plugin reads it directly without a cast.
    contextWindowManager:
      manager as unknown as TurnContext["contextWindowManager"],
  };
}

function makeResult(
  overrides: Partial<ContextWindowResultShape> = {},
): ContextWindowResultShape {
  return {
    compacted: true,
    summaryText: "default-summary",
    messages: [],
    previousEstimatedInputTokens: 1000,
    estimatedInputTokens: 100,
    maxInputTokens: 100000,
    thresholdTokens: 80000,
    compactedMessages: 3,
    compactedPersistedMessages: 3,
    summaryCalls: 1,
    summaryInputTokens: 500,
    summaryOutputTokens: 120,
    summaryModel: "default-model",
    ...overrides,
  };
}

describe("compaction pipeline", () => {
  test("default plugin delegates to the manager and returns its result unchanged", async () => {
    const observed: {
      messages: unknown;
      signal: unknown;
      options: unknown;
    }[] = [];
    const expected = makeResult({
      summaryText: "manager-summary",
      compactedMessages: 7,
    });
    const manager = {
      maybeCompact: async (
        messages: unknown,
        signal: unknown,
        options: unknown,
      ) => {
        observed.push({ messages, signal, options });
        return expected;
      },
    };
    const turnCtx = makeTurnCtx(manager);
    const args: CompactionArgs = {
      messages: [{ role: "user", content: "hi" }],
      signal: new AbortController().signal,
      options: { lastCompactedAt: 42, precomputedEstimate: 1234 },
    };

    // No middleware registered — the runner invokes the terminal directly.
    const result = (await runPipeline<CompactionArgs, CompactionResult>(
      "compaction",
      [],
      (innerArgs) => defaultCompactionTerminal(innerArgs, turnCtx),
      args,
      turnCtx,
      30000,
    )) as ContextWindowResultShape;

    // Terminal forwarded args verbatim to the manager.
    expect(observed).toHaveLength(1);
    expect(observed[0]!.messages).toBe(args.messages);
    expect(observed[0]!.signal).toBe(args.signal);
    expect(observed[0]!.options).toBe(args.options);

    // Returned result is the manager's object, unmodified — no wrapping
    // or shape transformation is allowed in the default path.
    expect(result).toBe(expected);
    expect(result.summaryText).toBe("manager-summary");
    expect(result.compactedMessages).toBe(7);
  });

  test("custom plugin short-circuits to a different summary without touching the manager", async () => {
    let managerCallCount = 0;
    const manager = {
      maybeCompact: async () => {
        managerCallCount++;
        return makeResult({ summaryText: "should-not-run" });
      },
    };
    const turnCtx = makeTurnCtx(manager);

    const custom: Middleware<CompactionArgs, CompactionResult> =
      async function customCompaction(_args, _next, _ctx) {
        // Short-circuit — omit the `next` call so the terminal never fires.
        return makeResult({
          summaryText: "custom-plugin-summary",
          compactedMessages: 0,
          summaryCalls: 0,
          reason: "short-circuited by custom plugin",
        });
      };

    const args: CompactionArgs = {
      messages: [],
      signal: undefined,
      options: undefined,
    };

    const result = (await runPipeline<CompactionArgs, CompactionResult>(
      "compaction",
      [custom],
      (innerArgs) => defaultCompactionTerminal(innerArgs, turnCtx),
      args,
      turnCtx,
      30000,
    )) as ContextWindowResultShape;

    expect(managerCallCount).toBe(0);
    expect(result.summaryText).toBe("custom-plugin-summary");
    expect(result.reason).toBe("short-circuited by custom plugin");
  });

  test("default terminal surfaces a PluginExecutionError when the manager is missing", async () => {
    // Build a turn context without the extension field so the default
    // terminal's lenient read fails — this guards against a future refactor
    // that removes the handle-attach helper in the orchestrator.
    const turnCtxWithoutManager: TurnContext = {
      requestId: "req-missing",
      conversationId: "conv-missing",
      turnIndex: 0,
      trust,
    };
    const args: CompactionArgs = {
      messages: [],
      signal: undefined,
      options: undefined,
    };

    await expect(
      defaultCompactionTerminal(args, turnCtxWithoutManager),
    ).rejects.toThrow(PluginExecutionError);
    await expect(
      defaultCompactionTerminal(args, turnCtxWithoutManager),
    ).rejects.toThrow(DEFAULT_COMPACTION_PLUGIN_NAME);
  });
});
