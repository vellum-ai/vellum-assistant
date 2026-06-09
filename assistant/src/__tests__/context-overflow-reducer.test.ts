import { beforeEach, describe, expect, mock, test } from "bun:test";

import { estimatePromptTokens } from "../context/token-estimator.js";
import type {
  CompactionContext,
  EmergencyCompactionContext,
} from "../plugins/defaults/compaction/compact.js";
import type { Message } from "../providers/types.js";

const SYSTEM_PROMPT = "You are a helpful assistant.";

// The reducer's compaction rungs call `defaultCompact` /
// `defaultEmergencyCompact`, which resolve the conversation's
// ContextWindowManager from the compaction store. Tests drive these impls to
// exercise rung progression without a live manager.
let compactImpl: (context: CompactionContext) => Promise<ContextWindowResult>;
let emergencyImpl: (
  context: EmergencyCompactionContext,
) => Promise<ContextWindowResult>;

mock.module("../plugins/defaults/compaction/compact.js", () => ({
  defaultCompact: (context: CompactionContext) => compactImpl(context),
  defaultEmergencyCompact: (context: EmergencyCompactionContext) =>
    emergencyImpl(context),
}));

import {
  createInitialReducerState,
  reduceContextOverflow,
  type ReducerConfig,
  type ReducerState,
} from "../plugins/defaults/compaction/context-overflow-reducer.js";
import {
  type ContextWindowResult,
  createContextSummaryMessage,
} from "../plugins/defaults/compaction/window-manager.js";

// The emergency rung (rung 0) runs first on every reduction step. Default it
// to a no-op so the ladder falls straight through to forced compaction — the
// rungs most tests exercise. Tests covering the emergency rung override
// `emergencyImpl` via useEmergencyCompacting().
beforeEach(() => {
  emergencyImpl = async ({ messages }) => noOpResult(messages);
});

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

function makeConfig(overrides?: Partial<ReducerConfig>): ReducerConfig {
  return {
    providerName: "mock",
    systemPrompt: SYSTEM_PROMPT,
    contextWindow: {
      enabled: true,
      maxInputTokens: 2000,
      targetBudgetRatio: 0.65,
      compactThreshold: 0.6,
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
    conversationId: "conv-overflow-test",
    previousEstimatedInputTokens: 2000,
    maxMiddleTierAttempts: 4,
    allowAutoCompressLatestTurn: false,
    ...overrides,
  };
}

/** A compaction result that replaces `messages` with a single summary. */
function compactedResult(
  messages: Message[],
  summaryText: string,
): ContextWindowResult {
  const compactedMessages = [createContextSummaryMessage(summaryText)];
  return {
    messages: compactedMessages,
    compacted: true,
    previousEstimatedInputTokens: estimatePromptTokens(
      messages,
      SYSTEM_PROMPT,
      {
        providerName: "mock",
      },
    ),
    estimatedInputTokens: estimatePromptTokens(
      compactedMessages,
      SYSTEM_PROMPT,
      {
        providerName: "mock",
      },
    ),
    maxInputTokens: 2000,
    thresholdTokens: 1200,
    compactedMessages: messages.length,
    compactedPersistedMessages: messages.length,
    summaryCalls: 1,
    summaryInputTokens: 100,
    summaryOutputTokens: 50,
    summaryModel: "mock-model",
    summaryText,
  } satisfies ContextWindowResult;
}

/** A compaction result that leaves `messages` untouched (no progress). */
function noOpResult(messages: Message[]): ContextWindowResult {
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
  } satisfies ContextWindowResult;
}

/**
 * Install a compaction stub that replaces messages with a summary.
 */
function useCompacting(summaryText = "## Goals\n- compacted summary"): void {
  compactImpl = async ({ messages }: CompactionContext) =>
    compactedResult(messages, summaryText);
}

/**
 * Install a compaction stub that cannot reduce (simulates compaction being
 * unable to make progress).
 */
function useNoOpCompacting(): void {
  compactImpl = async ({ messages }: CompactionContext) => noOpResult(messages);
}

/**
 * Install an emergency-compaction stub that replaces messages with a summary,
 * letting the emergency rung (rung 0) make progress on the first step.
 */
function useEmergencyCompacting(
  summaryText = "## Goals\n- emergency summary",
): void {
  emergencyImpl = async ({ messages }: EmergencyCompactionContext) =>
    compactedResult(messages, summaryText);
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
      useCompacting();

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
      useCompacting();

      let currentMessages = messages;
      let state: ReducerState | undefined;
      const tokenHistory: number[] = [];

      while (!state?.exhausted) {
        const result = await reduceContextOverflow(
          currentMessages,
          config,
          state,
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
      useCompacting();

      // Exhaust all tiers first
      let currentMessages = messages;
      let state: ReducerState | undefined;
      while (!state?.exhausted) {
        const result = await reduceContextOverflow(
          currentMessages,
          config,
          state,
        );
        currentMessages = result.messages;
        state = result.state;
      }

      // Run once more on exhausted state
      const finalResult = await reduceContextOverflow(
        currentMessages,
        config,
        state,
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
      useNoOpCompacting();

      const result = await reduceContextOverflow(messages, config, undefined);

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
      useNoOpCompacting();

      // Skip compaction, apply tool-result truncation
      const step1 = await reduceContextOverflow(messages, config, undefined);
      const step2 = await reduceContextOverflow(
        step1.messages,
        config,
        step1.state,
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
      useNoOpCompacting();

      let currentMessages = messages;
      let state: ReducerState | undefined;
      while (!state?.exhausted) {
        const result = await reduceContextOverflow(
          currentMessages,
          config,
          state,
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
      useCompacting();

      // Run 1
      const run1Tiers: string[] = [];
      const run1Tokens: number[] = [];
      let state1: ReducerState | undefined;
      let msgs1 = messages;
      while (!state1?.exhausted) {
        const r = await reduceContextOverflow(msgs1, config, state1);
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
        const r = await reduceContextOverflow(msgs2, config, state2);
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
      useCompacting();

      let state: ReducerState | undefined;
      let currentMessages = messages;
      const injectionModes: string[] = [];

      while (!state?.exhausted) {
        const result = await reduceContextOverflow(
          currentMessages,
          config,
          state,
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

  describe("budget-aware media stubbing", () => {
    test("media stubbing tier retains images within budget", async () => {
      // Create messages with multiple image-only user messages (5 images in the
      // latest user message). With budget-aware retention, the reducer should
      // keep more than the old hardcoded limit of 3 when targetTokens is high.
      const makeImageBlock = () => ({
        type: "image" as const,
        source: {
          type: "base64" as const,
          media_type: "image/png" as const,
          // Small base64 payload so each image doesn't cost many tokens
          data: "A".repeat(1_000),
        },
      });

      const messages: Message[] = [
        msg("user", "Here are some old images"),
        {
          role: "user",
          content: [makeImageBlock(), makeImageBlock()],
        },
        msg("assistant", "I see the old images."),
        msg("user", "And some more old images"),
        {
          role: "user",
          content: [makeImageBlock()],
        },
        msg("assistant", "Got those too."),
        // Latest user message with 5 images — should retain more than 3
        {
          role: "user",
          content: [
            makeImageBlock(),
            makeImageBlock(),
            makeImageBlock(),
            makeImageBlock(),
            makeImageBlock(),
          ],
        },
      ];

      // Set targetTokens very high so all images in the latest message fit
      const config = makeConfig({
        targetTokens: 500_000,
      });
      useNoOpCompacting();

      // Run through forced_compaction and tool_result_truncation first
      const step1 = await reduceContextOverflow(messages, config, undefined);
      expect(step1.tier).toBe("forced_compaction");

      const step2 = await reduceContextOverflow(
        step1.messages,
        config,
        step1.state,
      );
      expect(step2.tier).toBe("tool_result_truncation");

      // Now apply media stubbing
      const step3 = await reduceContextOverflow(
        step2.messages,
        config,
        step2.state,
      );
      expect(step3.tier).toBe("media_stubbing");

      // Count remaining image blocks in the latest user message
      const latestUserMsg = step3.messages[step3.messages.length - 1];
      expect(latestUserMsg.role).toBe("user");
      const remainingImages = latestUserMsg.content.filter(
        (b) => b.type === "image",
      );

      // With budget-aware retention and a high target, all 5 images should be
      // retained — more than the old hardcoded limit of 3.
      expect(remainingImages.length).toBeGreaterThan(3);
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
      useCompacting();

      const result = await reduceContextOverflow(messages, config, undefined);

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
      useCompacting();

      // Skip past compaction tier
      const step1 = await reduceContextOverflow(messages, config, undefined);
      const step2 = await reduceContextOverflow(
        step1.messages,
        config,
        step1.state,
      );

      expect(step2.tier).toBe("tool_result_truncation");
      expect(step2.compactionResult).toBeUndefined();
    });
  });

  describe("emergency compaction rung", () => {
    test("emergency rung runs first and forwards its compaction result", async () => {
      const messages: Message[] = [
        msg("user", "do something"),
        toolUseMsg("tu_1", "bash"),
        toolResultMsg("tu_1", "x".repeat(8000)),
      ];

      const config = makeConfig();
      useCompacting();
      useEmergencyCompacting();

      const result = await reduceContextOverflow(messages, config, undefined);

      expect(result.tier).toBe("emergency_compaction");
      expect(result.state.appliedTiers).toEqual(["emergency_compaction"]);
      expect(result.compactionResult?.compacted).toBe(true);
      expect(result.state.exhausted).toBe(false);
    });

    test("when emergency cannot reduce, the same step falls through to forced compaction", async () => {
      const messages: Message[] = [
        msg("user", "Hello"),
        msg("assistant", "World"),
      ];

      const config = makeConfig();
      useCompacting();

      // Default emergency stub is a no-op, so the step falls through.
      const result = await reduceContextOverflow(messages, config, undefined);

      expect(result.tier).toBe("forced_compaction");
      expect(result.state.appliedTiers).toEqual([
        "emergency_compaction",
        "forced_compaction",
      ]);
    });
  });

  describe("terminal auto-compress rung", () => {
    test("auto-compress runs as the final rung when the policy permits it", async () => {
      const messages: Message[] = [
        msg("user", "Hello"),
        msg("assistant", "World"),
      ];

      const config = makeConfig({ allowAutoCompressLatestTurn: true });
      useCompacting();

      let state: ReducerState | undefined;
      let currentMessages = messages;
      const tiers: string[] = [];
      while (!state?.exhausted) {
        const result = await reduceContextOverflow(
          currentMessages,
          config,
          state,
        );
        tiers.push(result.tier);
        currentMessages = result.messages;
        state = result.state;
      }

      expect(tiers[tiers.length - 1]).toBe("auto_compress_latest_turn");
      expect(state!.appliedTiers).toContain("auto_compress_latest_turn");
    });

    test("auto-compress is skipped when the policy disallows it", async () => {
      const messages: Message[] = [
        msg("user", "Hello"),
        msg("assistant", "World"),
      ];

      const config = makeConfig({ allowAutoCompressLatestTurn: false });
      useCompacting();

      let state: ReducerState | undefined;
      let currentMessages = messages;
      const tiers: string[] = [];
      while (!state?.exhausted) {
        const result = await reduceContextOverflow(
          currentMessages,
          config,
          state,
        );
        tiers.push(result.tier);
        currentMessages = result.messages;
        state = result.state;
      }

      expect(tiers).not.toContain("auto_compress_latest_turn");
      expect(tiers[tiers.length - 1]).toBe("injection_downgrade");
    });
  });

  describe("middle-tier attempt budget", () => {
    test("the ladder escalates once maxMiddleTierAttempts middle rungs run", async () => {
      const messages: Message[] = [
        msg("user", "Hello"),
        msg("assistant", "World"),
      ];

      const config = makeConfig({
        maxMiddleTierAttempts: 2,
        allowAutoCompressLatestTurn: false,
      });
      useCompacting();

      let state: ReducerState | undefined;
      let currentMessages = messages;
      const tiers: string[] = [];
      while (!state?.exhausted) {
        const result = await reduceContextOverflow(
          currentMessages,
          config,
          state,
        );
        tiers.push(result.tier);
        currentMessages = result.messages;
        state = result.state;
      }

      // Only two middle tiers run before the ladder is exhausted; media
      // stubbing and injection downgrade are never reached.
      expect(tiers).toEqual(["forced_compaction", "tool_result_truncation"]);
      expect(tiers).not.toContain("media_stubbing");
      expect(tiers).not.toContain("injection_downgrade");
    });
  });
});
