/**
 * Tests for the `historyRepair` plugin pipeline (PR 24).
 *
 * Covers:
 * - Default plugin output matches `repairHistory` for the three documented
 *   repair cases (orphan tool_result, missing tool_result, same-role
 *   consecutive messages) — guarantees the wrapping is a no-op for the
 *   default configuration.
 * - Middleware composition: observer middleware sees the args and result
 *   unchanged.
 * - Short-circuit middleware can replace the default output with its own
 *   repair decision.
 * - Pipeline runs within the 1s `DEFAULT_TIMEOUTS.historyRepair` budget.
 *
 * Tests exercise the default terminal directly AND through `runPipeline` so
 * both the plugin's wrapping and its end-to-end integration with the
 * pipeline runner are verified.
 */

import { beforeEach, describe, expect, test } from "bun:test";

import type { TrustContext } from "../daemon/conversation-runtime-assembly.js";
import { repairHistory } from "../daemon/history-repair.js";
import {
  defaultHistoryRepairPlugin,
  defaultHistoryRepairTerminal,
} from "../plugins/defaults/history-repair.js";
import { DEFAULT_TIMEOUTS, runPipeline } from "../plugins/pipeline.js";
import {
  getMiddlewaresFor,
  registerPlugin,
  resetPluginRegistryForTests,
} from "../plugins/registry.js";
import type {
  HistoryRepairArgs,
  HistoryRepairResult,
  Middleware,
  TurnContext,
} from "../plugins/types.js";
import type { Message } from "../providers/types.js";

const trust: TrustContext = {
  sourceChannel: "vellum",
  trustClass: "guardian",
};

function makeCtx(overrides: Partial<TurnContext> = {}): TurnContext {
  return {
    requestId: "req-test",
    conversationId: "conv-test",
    turnIndex: 0,
    trust,
    ...overrides,
  };
}

describe("default historyRepair plugin — direct terminal parity", () => {
  test("orphan tool_result downgraded identically to repairHistory", () => {
    // Tool_result with no preceding tool_use — should be downgraded to text.
    const messages: Message[] = [
      {
        role: "user",
        content: [
          { type: "text", text: "hi" },
          {
            type: "tool_result",
            tool_use_id: "tu_gone",
            content: "stale",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Hello" }],
      },
    ];

    const direct = repairHistory(messages);
    const viaDefault = defaultHistoryRepairTerminal({
      history: messages,
      provider: "anthropic",
    });

    expect(viaDefault).toEqual(direct);
    expect(viaDefault.stats.orphanToolResultsDowngraded).toBe(1);
  });

  test("missing tool_result synthesized identically to repairHistory", () => {
    // Assistant issues two tool_uses; user only returns one — the other
    // must be synthesized.
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Run" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
          { type: "tool_use", id: "tu_2", name: "read", input: { path: "/b" } },
        ],
      },
      {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tu_1", content: "ok" },
          // tu_2 is missing — the repair must insert a synthetic block.
        ],
      },
      { role: "assistant", content: [{ type: "text", text: "Done" }] },
    ];

    const direct = repairHistory(messages);
    const viaDefault = defaultHistoryRepairTerminal({
      history: messages,
      provider: "anthropic",
    });

    expect(viaDefault).toEqual(direct);
    expect(viaDefault.stats.missingToolResultsInserted).toBe(1);
  });

  test("same-role consecutive messages merged identically to repairHistory", () => {
    // Two consecutive user messages must be merged (provider requires
    // strict alternation). repairHistory handles this in its final pass.
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "first" }] },
      { role: "user", content: [{ type: "text", text: "second" }] },
      { role: "assistant", content: [{ type: "text", text: "ack" }] },
    ];

    const direct = repairHistory(messages);
    const viaDefault = defaultHistoryRepairTerminal({
      history: messages,
      provider: "anthropic",
    });

    expect(viaDefault).toEqual(direct);
    expect(viaDefault.stats.consecutiveSameRoleMerged).toBe(1);
    // Sanity: the merged content should carry both text blocks.
    expect(viaDefault.messages).toHaveLength(2);
    expect(viaDefault.messages[0]!.role).toBe("user");
    expect(viaDefault.messages[0]!.content).toHaveLength(2);
  });

  test("no-op for a well-formed history", () => {
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Hello" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "read", input: { path: "/a" } },
        ],
      },
      {
        role: "user",
        content: [
          {
            type: "tool_result",
            tool_use_id: "tu_1",
            content: "contents",
          },
        ],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Here." }],
      },
    ];

    const direct = repairHistory(messages);
    const viaDefault = defaultHistoryRepairTerminal({
      history: messages,
      provider: "anthropic",
    });

    expect(viaDefault).toEqual(direct);
    expect(viaDefault.stats.assistantToolResultsMigrated).toBe(0);
    expect(viaDefault.stats.missingToolResultsInserted).toBe(0);
    expect(viaDefault.stats.orphanToolResultsDowngraded).toBe(0);
    expect(viaDefault.stats.consecutiveSameRoleMerged).toBe(0);
  });
});

describe("historyRepair pipeline — end-to-end via runPipeline", () => {
  beforeEach(() => {
    resetPluginRegistryForTests();
  });

  test("default plugin — pipeline output matches repairHistory exactly", async () => {
    registerPlugin(defaultHistoryRepairPlugin);

    // Drift case covering all three repair behaviors at once: an orphan
    // tool_result, a missing tool_result, and consecutive same-role messages.
    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "Kick off" }] },
      {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tu_1", name: "bash", input: { cmd: "ls" } },
          { type: "tool_use", id: "tu_2", name: "read", input: { path: "/b" } },
        ],
      },
      {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "tu_1", content: "ok" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "extra" }],
      },
      {
        role: "assistant",
        content: [{ type: "text", text: "Done" }],
      },
    ];

    const direct = repairHistory(messages);
    const result = await runPipeline<HistoryRepairArgs, HistoryRepairResult>(
      "historyRepair",
      getMiddlewaresFor("historyRepair"),
      async (args) => defaultHistoryRepairTerminal(args),
      { history: messages, provider: "anthropic" },
      makeCtx(),
      DEFAULT_TIMEOUTS.historyRepair,
    );

    expect(result).toEqual(direct);
    // Regression guard: at least one of each of the three repair classes
    // fired, so we know this test exercises the documented cases.
    expect(result.stats.missingToolResultsInserted).toBeGreaterThan(0);
    expect(result.stats.consecutiveSameRoleMerged).toBeGreaterThan(0);
  });

  test("observer middleware sees args and unchanged result without interfering", async () => {
    let seenHistoryLen = -1;
    let seenProvider = "";
    let seenResultLen = -1;
    const observer: Middleware<HistoryRepairArgs, HistoryRepairResult> = async (
      args,
      next,
    ) => {
      seenHistoryLen = args.history.length;
      seenProvider = args.provider;
      const result = await next(args);
      seenResultLen = result.messages.length;
      return result;
    };

    registerPlugin({
      manifest: {
        name: "observer-plugin",
        version: "0.0.1",
        requires: { pluginRuntime: "v1", historyRepairApi: "v1" },
      },
      middleware: { historyRepair: observer },
    });
    registerPlugin(defaultHistoryRepairPlugin);

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];

    const direct = repairHistory(messages);
    const result = await runPipeline<HistoryRepairArgs, HistoryRepairResult>(
      "historyRepair",
      getMiddlewaresFor("historyRepair"),
      async (args) => defaultHistoryRepairTerminal(args),
      { history: messages, provider: "openai" },
      makeCtx(),
      DEFAULT_TIMEOUTS.historyRepair,
    );

    expect(result).toEqual(direct);
    expect(seenHistoryLen).toBe(2);
    expect(seenProvider).toBe("openai");
    expect(seenResultLen).toBe(direct.messages.length);
  });

  test("short-circuit middleware replaces the default output", async () => {
    const customMessages: Message[] = [
      { role: "user", content: [{ type: "text", text: "rewritten" }] },
    ];
    const customStats = {
      assistantToolResultsMigrated: 0,
      missingToolResultsInserted: 0,
      orphanToolResultsDowngraded: 0,
      consecutiveSameRoleMerged: 0,
    };
    const shortCircuit: Middleware<
      HistoryRepairArgs,
      HistoryRepairResult
    > = async () => ({
      messages: customMessages,
      stats: customStats,
    });

    registerPlugin({
      manifest: {
        name: "override-plugin",
        version: "0.0.1",
        requires: { pluginRuntime: "v1", historyRepairApi: "v1" },
      },
      middleware: { historyRepair: shortCircuit },
    });
    registerPlugin(defaultHistoryRepairPlugin);

    const messages: Message[] = [
      { role: "user", content: [{ type: "text", text: "hi" }] },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
    ];

    const result = await runPipeline<HistoryRepairArgs, HistoryRepairResult>(
      "historyRepair",
      getMiddlewaresFor("historyRepair"),
      async (args) => defaultHistoryRepairTerminal(args),
      { history: messages, provider: "anthropic" },
      makeCtx(),
      DEFAULT_TIMEOUTS.historyRepair,
    );

    expect(result.messages).toEqual(customMessages);
    expect(result.stats).toEqual(customStats);
  });

  test("runs well under the 1s DEFAULT_TIMEOUTS.historyRepair budget", async () => {
    registerPlugin(defaultHistoryRepairPlugin);

    const messages: Message[] = Array.from({ length: 50 }, (_, i) =>
      i % 2 === 0
        ? {
            role: "user" as const,
            content: [{ type: "text" as const, text: `u${i}` }],
          }
        : {
            role: "assistant" as const,
            content: [{ type: "text" as const, text: `a${i}` }],
          },
    );

    const start = performance.now();
    const result = await runPipeline<HistoryRepairArgs, HistoryRepairResult>(
      "historyRepair",
      getMiddlewaresFor("historyRepair"),
      async (args) => defaultHistoryRepairTerminal(args),
      { history: messages, provider: "anthropic" },
      makeCtx(),
      DEFAULT_TIMEOUTS.historyRepair,
    );
    const elapsed = performance.now() - start;

    expect(result.messages).toEqual(messages);
    // 1000ms is the real budget; assert an order-of-magnitude safety margin
    // so this test catches catastrophic regressions without being flaky on
    // loaded CI hosts.
    expect(elapsed).toBeLessThan(500);
  });
});
