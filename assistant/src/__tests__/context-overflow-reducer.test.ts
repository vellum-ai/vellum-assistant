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
  type ReducerConfig,
  type ReducerState,
} from "../daemon/context-overflow-reducer.js";
import type { Message } from "../providers/types.js";

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

function imageMsg(): Message {
  return {
    role: "user",
    content: [
      {
        type: "image",
        source: {
          type: "base64",
          media_type: "image/png",
          data: "A".repeat(10_000),
        },
      },
    ],
  };
}

const SYSTEM_PROMPT = "You are a helpful assistant.";

function makeConfig(overrides?: Partial<ReducerConfig>): ReducerConfig {
  return {
    providerName: "mock",
    systemPrompt: SYSTEM_PROMPT,
    contextWindow: {
      enabled: true,
      maxInputTokens: 2000,
      targetInputTokens: 1200,
      compactThreshold: 0.6,
      preserveRecentUserTurns: 2,
      summaryBudgetRatio: 0.05,
      overflowRecovery: {
        enabled: true,
        safetyMarginRatio: 0.05,
        maxAttempts: 3,
        interactiveLatestTurnCompression: "summarize",
        nonInteractiveLatestTurnCompression: "truncate",
      },
    },
    targetTokens: 1000,
    ...overrides,
  };
}

/**
 * Create a mock compaction function that replaces messages with a summary.
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
 * Create a compact function that does not compact (simulates compaction
 * being unable to reduce further).
 */
function makeNoOpCompactFn(): (
  messages: Message[],
  signal: AbortSignal | undefined,
  options: ContextWindowCompactOptions,
) => Promise<ContextWindowResult> {
  return async (messages, _signal, _options) => {
    const estimatedInputTokens = estimatePromptTokens(messages, SYSTEM_PROMPT, {
      providerName: "mock",
    });
    return {
      messages,
      compacted: false,
      previousEstimatedInputTokens: estimatedInputTokens,
      estimatedInputTokens,
      maxInputTokens: 2000,
      thresholdTokens: 1200,
      compactedMessages: 0,
      compactedPersistedMessages: 0,
      summaryCalls: 0,
      summaryInputTokens: 0,
      summaryOutputTokens: 0,
      summaryModel: "",
      summaryText: "",
      reason: "unable to compact",
    };
  };
}

describe("context-overflow-reducer", () => {
  describe("monotonic token reduction", () => {
    test("each tier reduces estimated tokens or advances state without loops", async () => {
      const longText = "x".repeat(2000);
      const longToolResult = "r".repeat(8000);
      const messages: Message[] = [
        msg("user", `Question about ${longText}`),
        toolUseMsg("tu_1", "read_file"),
        toolResultMsg("tu_1", longToolResult),
        msg("assistant", `Here is the answer: ${longText}`),
        msg("user", "Follow-up question"),
        toolUseMsg("tu_2", "write_file"),
        toolResultMsg("tu_2", longToolResult),
        imageMsg(),
        msg("assistant", "Done"),
        msg("user", "Thanks"),
      ];

      const config = makeConfig();
      const compactFn = makeCompactFn();

      let state: ReducerState | undefined;
      let prevTokens = Infinity;
      let currentMessages = messages;
      const tiersApplied: string[] = [];

      // Iterate through all tiers
      for (let i = 0; i < 5; i++) {
        const result = await reduceContextOverflow(
          currentMessages,
          config,
          state,
          compactFn,
        );

        // Each step should either reduce tokens or advance tier state
        expect(result.estimatedTokens).toBeLessThanOrEqual(prevTokens);
        tiersApplied.push(result.tier);
        prevTokens = result.estimatedTokens;
        currentMessages = result.messages;
        state = result.state;

        if (state.exhausted) break;
      }

      // All four tiers should have been applied
      expect(tiersApplied).toContain("forced_compaction");
      expect(tiersApplied).toContain("tool_result_truncation");
      expect(tiersApplied).toContain("media_stubbing");
      expect(tiersApplied).toContain("injection_downgrade");
      expect(state!.exhausted).toBe(true);
    });

    test("step-by-step iteration produces monotonically non-increasing tokens", async () => {
      const longToolResult = "r".repeat(12000);
      const messages: Message[] = [
        msg("user", "Start"),
        toolUseMsg("tu_1", "read_file"),
        toolResultMsg("tu_1", longToolResult),
        msg("assistant", "Result"),
        imageMsg(),
        msg("user", "Next"),
      ];

      const config = makeConfig();
      const compactFn = makeCompactFn();

      let currentMessages = messages;
      let state: ReducerState | undefined;
      const tokenHistory: number[] = [];

      while (!state?.exhausted) {
        const result = await reduceContextOverflow(
          currentMessages,
          config,
          state,
          compactFn,
        );
        tokenHistory.push(result.estimatedTokens);
        currentMessages = result.messages;
        state = result.state;
      }

      // Verify monotonic non-increasing
      for (let i = 1; i < tokenHistory.length; i++) {
        expect(tokenHistory[i]).toBeLessThanOrEqual(tokenHistory[i - 1]);
      }
    });
  });

  describe("tier idempotency at floor", () => {
    test("re-running the reducer on already-exhausted state returns same messages", async () => {
      const messages: Message[] = [
        msg("user", "Hello"),
        msg("assistant", "Hi there"),
      ];

      const config = makeConfig();
      const compactFn = makeCompactFn();

      // Exhaust all tiers first
      let currentMessages = messages;
      let state: ReducerState | undefined;
      while (!state?.exhausted) {
        const result = await reduceContextOverflow(
          currentMessages,
          config,
          state,
          compactFn,
        );
        currentMessages = result.messages;
        state = result.state;
      }

      // Run once more on exhausted state
      const finalResult = await reduceContextOverflow(
        currentMessages,
        config,
        state,
        compactFn,
      );

      expect(finalResult.state.exhausted).toBe(true);
      // Messages should not change further
      expect(finalResult.estimatedTokens).toBe(
        estimatePromptTokens(currentMessages, SYSTEM_PROMPT, {
          providerName: "mock",
        }),
      );
    });

    test("when compaction cannot reduce, tier still advances", async () => {
      const messages: Message[] = [
        msg("user", "Hello"),
        msg("assistant", "World"),
      ];

      const config = makeConfig();
      const noOpCompact = makeNoOpCompactFn();

      const result = await reduceContextOverflow(
        messages,
        config,
        undefined,
        noOpCompact,
      );

      expect(result.tier).toBe("forced_compaction");
      expect(result.state.appliedTiers).toContain("forced_compaction");
      // Messages unchanged since compaction couldn't reduce
      expect(result.messages).toBe(messages);
    });
  });

  describe("preserved tool-use/tool-result structural validity", () => {
    test("tool-result blocks retain their tool_use_id after truncation", async () => {
      const longContent = "c".repeat(10000);
      const messages: Message[] = [
        msg("user", "do something"),
        toolUseMsg("tu_abc", "bash"),
        toolResultMsg("tu_abc", longContent),
        msg("assistant", "done"),
        msg("user", "ok"),
      ];

      const config = makeConfig();
      const compactFn = makeNoOpCompactFn();

      // Skip compaction, apply tool-result truncation
      const step1 = await reduceContextOverflow(
        messages,
        config,
        undefined,
        compactFn,
      );
      const step2 = await reduceContextOverflow(
        step1.messages,
        config,
        step1.state,
        compactFn,
      );

      expect(step2.tier).toBe("tool_result_truncation");

      // Find tool_result blocks in output and verify structural integrity
      for (const m of step2.messages) {
        for (const block of m.content) {
          if (block.type === "tool_result") {
            expect(block.tool_use_id).toBe("tu_abc");
            expect(typeof block.content).toBe("string");
          }
        }
      }
    });

    test("tool-use and tool-result pairs remain matched after all tiers", async () => {
      const messages: Message[] = [
        msg("user", "start"),
        toolUseMsg("tu_1", "read_file"),
        toolResultMsg("tu_1", "x".repeat(8000)),
        toolUseMsg("tu_2", "write_file"),
        toolResultMsg("tu_2", "y".repeat(8000)),
        msg("assistant", "done"),
        msg("user", "thanks"),
      ];

      const config = makeConfig();
      const compactFn = makeNoOpCompactFn();

      let currentMessages = messages;
      let state: ReducerState | undefined;
      while (!state?.exhausted) {
        const result = await reduceContextOverflow(
          currentMessages,
          config,
          state,
          compactFn,
        );
        currentMessages = result.messages;
        state = result.state;
      }

      // Collect all tool_use ids and tool_result ids
      const toolUseIds = new Set<string>();
      const toolResultIds = new Set<string>();
      for (const m of currentMessages) {
        for (const block of m.content) {
          if (block.type === "tool_use") {
            toolUseIds.add(block.id);
          } else if (block.type === "tool_result") {
            toolResultIds.add(block.tool_use_id);
          }
        }
      }

      // Every tool_result must reference a tool_use that exists
      for (const id of toolResultIds) {
        expect(toolUseIds.has(id)).toBe(true);
      }
    });
  });

  describe("deterministic outputs", () => {
    test("identical inputs produce identical tier progression", async () => {
      const messages: Message[] = [
        msg("user", "Hello"),
        toolUseMsg("tu_1", "bash"),
        toolResultMsg("tu_1", "output ".repeat(1000)),
        msg("assistant", "Here you go"),
        imageMsg(),
        msg("user", "Next"),
      ];

      const config = makeConfig();
      const compactFn = makeCompactFn();

      // Run 1
      const run1Tiers: string[] = [];
      const run1Tokens: number[] = [];
      let state1: ReducerState | undefined;
      let msgs1 = messages;
      while (!state1?.exhausted) {
        const r = await reduceContextOverflow(msgs1, config, state1, compactFn);
        run1Tiers.push(r.tier);
        run1Tokens.push(r.estimatedTokens);
        msgs1 = r.messages;
        state1 = r.state;
      }

      // Run 2 (same inputs)
      const run2Tiers: string[] = [];
      const run2Tokens: number[] = [];
      let state2: ReducerState | undefined;
      let msgs2 = messages;
      while (!state2?.exhausted) {
        const r = await reduceContextOverflow(msgs2, config, state2, compactFn);
        run2Tiers.push(r.tier);
        run2Tokens.push(r.estimatedTokens);
        msgs2 = r.messages;
        state2 = r.state;
      }

      expect(run1Tiers).toEqual(run2Tiers);
      expect(run1Tokens).toEqual(run2Tokens);
    });
  });

  describe("injection mode progression", () => {
    test("injection mode starts full and ends minimal after all tiers", async () => {
      const messages: Message[] = [
        msg("user", "Hello"),
        msg("assistant", "World"),
      ];

      const config = makeConfig();
      const compactFn = makeCompactFn();

      let state: ReducerState | undefined;
      let currentMessages = messages;
      const injectionModes: string[] = [];

      while (!state?.exhausted) {
        const result = await reduceContextOverflow(
          currentMessages,
          config,
          state,
          compactFn,
        );
        injectionModes.push(result.state.injectionMode);
        currentMessages = result.messages;
        state = result.state;
      }

      // First three tiers keep full injection mode
      expect(injectionModes[0]).toBe("full");
      expect(injectionModes[1]).toBe("full");
      expect(injectionModes[2]).toBe("full");
      // Final tier downgrades to minimal
      expect(injectionModes[3]).toBe("minimal");
    });
  });

  describe("createInitialReducerState", () => {
    test("returns a clean state with no applied tiers", () => {
      const state = createInitialReducerState();
      expect(state.appliedTiers).toEqual([]);
      expect(state.injectionMode).toBe("full");
      expect(state.exhausted).toBe(false);
    });
  });

  describe("compaction result forwarding", () => {
    test("forced compaction tier includes compactionResult", async () => {
      const messages: Message[] = [
        msg("user", "Hello"),
        msg("assistant", "World"),
      ];

      const config = makeConfig();
      const compactFn = makeCompactFn();

      const result = await reduceContextOverflow(
        messages,
        config,
        undefined,
        compactFn,
      );

      expect(result.tier).toBe("forced_compaction");
      expect(result.compactionResult).toBeDefined();
      expect(result.compactionResult!.compacted).toBe(true);
      expect(result.compactionResult!.summaryText).toBe(
        "## Goals\n- compacted summary",
      );
    });

    test("non-compaction tiers do not include compactionResult", async () => {
      const messages: Message[] = [
        msg("user", "Hello"),
        msg("assistant", "World"),
      ];

      const config = makeConfig();
      const compactFn = makeCompactFn();

      // Skip past compaction tier
      const step1 = await reduceContextOverflow(
        messages,
        config,
        undefined,
        compactFn,
      );
      const step2 = await reduceContextOverflow(
        step1.messages,
        config,
        step1.state,
        compactFn,
      );

      expect(step2.tier).toBe("tool_result_truncation");
      expect(step2.compactionResult).toBeUndefined();
    });
  });
});
