/**
 * Coverage for the turn-scoped overflow-recovery state machine that lives on
 * `ContextWindowManager.reduceOverflowOneRung`. The manager holds the reducer
 * state across the successive rung calls of a single turn, derives the
 * compaction target from its own preflight budget corrected by the provider's
 * actual token count, and starts a fresh ladder once the turn boundary resets
 * it. `reduceContextOverflow` is mocked so these tests pin the manager's own
 * orchestration without exercising the full reduction ladder.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../daemon/conversation-registry.js", () => ({
  findConversationOrSubagent: () => ({
    systemPrompt: "you are a test assistant",
  }),
}));

// ── Module-level mock state ───────────────────────────────────────────
// The reducer call is captured so tests can assert which state and config the
// manager fed in; the returned step is seeded per call so tests can drive the
// ladder forward across rungs.

interface ReducerState {
  appliedTiers: string[];
  injectionMode: string;
  exhausted: boolean;
}

interface ReducerStepResult {
  messages: unknown;
  tier: string;
  state: ReducerState;
  estimatedTokens: number;
}

let reduceCalls: Array<{
  messages: unknown;
  config: Record<string, unknown>;
  state: ReducerState | undefined;
}> = [];
let reduceSteps: ReducerStepResult[] = [];

const estimateReturns: number[] = [];

mock.module("../context/token-estimator.js", () => ({
  estimatePromptTokens: (): number => {
    const next = estimateReturns.shift();
    if (next === undefined) {
      throw new Error(
        "estimatePromptTokens called more times than estimateReturns seeded",
      );
    }
    return next;
  },
  // Deterministic per-tool budget so tests can assert the manager fed the
  // turn's resolved tool set (not the constructor-time snapshot) into the
  // overflow estimate.
  estimateToolsTokens: (tools: unknown[]): number => tools.length * 1_000,
}));

mock.module(
  "../plugins/defaults/compaction/context-overflow-reducer.js",
  () => ({
    createInitialReducerState: (): ReducerState => ({
      appliedTiers: [],
      injectionMode: "full",
      exhausted: false,
    }),
    reduceContextOverflow: async (
      messages: unknown,
      config: Record<string, unknown>,
      state: ReducerState | undefined,
    ): Promise<ReducerStepResult> => {
      reduceCalls.push({ messages, config, state });
      const idx = reduceCalls.length - 1;
      const step = reduceSteps[idx];
      if (!step) {
        throw new Error(
          `Mock reducer called ${reduceCalls.length} time(s) but only ${reduceSteps.length} step(s) seeded`,
        );
      }
      return step;
    },
  }),
);

import { ContextWindowManager } from "../plugins/defaults/compaction/window-manager.js";
import type { Message, Provider, ToolDefinition } from "../providers/types.js";

function makeProvider(): Provider {
  return {
    name: "mock-provider",
    sendMessage: async () => ({
      content: [],
      model: "mock-model",
      usage: { inputTokens: 0, outputTokens: 0 },
      stopReason: "end_turn",
    }),
  };
}

function makeMessages(count: number): Message[] {
  const messages: Message[] = [];
  for (let i = 0; i < count; i++) {
    messages.push({
      role: i % 2 === 0 ? "user" : "assistant",
      content: [{ type: "text", text: `msg ${i}` }],
    });
  }
  return messages;
}

function makeConfig(maxAttempts: number = 3) {
  return {
    enabled: true,
    maxInputTokens: 200_000,
    targetBudgetRatio: 0.3,
    compactThreshold: 0.8,
    summaryBudgetRatio: 0.05,
    overflowRecovery: {
      enabled: true,
      safetyMarginRatio: 0.05,
      maxAttempts,
      interactiveLatestTurnCompression: "summarize" as const,
      nonInteractiveLatestTurnCompression: "summarize" as const,
    },
  };
}

function buildManager(maxAttempts: number = 3): ContextWindowManager {
  return new ContextWindowManager({
    provider: makeProvider(),
    config: makeConfig(maxAttempts),
    conversationId: "conv-test",
  });
}

function makeStep(
  appliedTiers: string[],
  exhausted: boolean = false,
): ReducerStepResult {
  return {
    messages: makeMessages(2),
    tier: appliedTiers[appliedTiers.length - 1] ?? "emergency_compaction",
    state: { appliedTiers, injectionMode: "full", exhausted },
    estimatedTokens: 100_000,
  };
}

describe("ContextWindowManager.reduceOverflowOneRung", () => {
  beforeEach(() => {
    reduceCalls = [];
    reduceSteps = [];
    estimateReturns.length = 0;
  });

  test("holds reducer state across rungs within a turn", async () => {
    // GIVEN a manager and a reducer that advances the ladder one rung per call
    estimateReturns.push(240_000, 240_000);
    reduceSteps = [
      makeStep(["emergency_compaction"]),
      makeStep(["emergency_compaction", "forced_compaction"]),
    ];
    const manager = buildManager();

    // WHEN two rungs run within the same turn
    await manager.reduceOverflowOneRung(makeMessages(10), {
      actualTokens: null,
      allowAutoCompressLatestTurn: false,
    });
    await manager.reduceOverflowOneRung(makeMessages(10), {
      actualTokens: null,
      allowAutoCompressLatestTurn: false,
    });

    // THEN the first call seeds an empty ladder
    expect(reduceCalls).toHaveLength(2);
    expect(reduceCalls[0]?.state?.appliedTiers).toEqual([]);
    // AND the second call carries the first rung's state forward
    expect(reduceCalls[1]?.state?.appliedTiers).toEqual([
      "emergency_compaction",
    ]);
  });

  test("reuses the first rung's corrected target across the turn's later rungs", async () => {
    // GIVEN the provider rejected at 480k while the estimator counted 240k, and
    // only one estimate is seeded so a second estimate call would throw
    estimateReturns.push(240_000);
    reduceSteps = [
      makeStep(["emergency_compaction"]),
      makeStep(["emergency_compaction", "forced_compaction"]),
    ];
    const manager = buildManager();

    // WHEN two rungs run within the same turn with the provider's actual count
    await manager.reduceOverflowOneRung(makeMessages(10), {
      actualTokens: 480_000,
      allowAutoCompressLatestTurn: false,
    });
    await manager.reduceOverflowOneRung(makeMessages(4), {
      actualTokens: 480_000,
      allowAutoCompressLatestTurn: false,
    });

    // THEN the corrected target (190k preflight / 2x error ratio) is computed
    // once and reused, rather than re-derived against the shrunk prompt
    expect(reduceCalls[0]?.config.targetTokens).toBe(95_000);
    expect(reduceCalls[1]?.config.targetTokens).toBe(95_000);
    expect(reduceCalls[0]?.config.previousEstimatedInputTokens).toBe(240_000);
    expect(reduceCalls[1]?.config.previousEstimatedInputTokens).toBe(240_000);
  });

  test("resetOverflowRecovery starts a fresh ladder", async () => {
    // GIVEN a manager whose ladder has already advanced one rung
    estimateReturns.push(240_000, 240_000);
    reduceSteps = [
      makeStep(["emergency_compaction"]),
      makeStep(["emergency_compaction"]),
    ];
    const manager = buildManager();
    await manager.reduceOverflowOneRung(makeMessages(10), {
      actualTokens: null,
      allowAutoCompressLatestTurn: false,
    });

    // WHEN the turn boundary resets recovery and a new rung runs
    manager.resetOverflowRecovery();
    await manager.reduceOverflowOneRung(makeMessages(10), {
      actualTokens: null,
      allowAutoCompressLatestTurn: false,
    });

    // THEN the post-reset call seeds an empty ladder again
    expect(reduceCalls[1]?.state?.appliedTiers).toEqual([]);
  });

  test("corrected target lowers below preflight when the provider under-counted", async () => {
    // GIVEN the provider rejected at 480k while the estimator counted 240k
    estimateReturns.push(240_000);
    reduceSteps = [makeStep(["emergency_compaction"])];
    const manager = buildManager();

    // WHEN a rung runs with the provider's actual token count
    await manager.reduceOverflowOneRung(makeMessages(10), {
      actualTokens: 480_000,
      allowAutoCompressLatestTurn: false,
    });

    // THEN the target is the preflight budget (200k * 0.95 = 190k) divided by
    // the 2x estimation-error ratio
    expect(reduceCalls[0]?.config.targetTokens).toBe(95_000);
  });

  test("estimates against the turn's resolved tool set, not the constructor snapshot", async () => {
    // GIVEN a manager whose live tool set (3 tools) differs from the stale
    // constructor-time budget snapshot
    estimateReturns.push(240_000);
    reduceSteps = [makeStep(["emergency_compaction"])];
    const resolvedTools = [
      { name: "a" },
      { name: "b" },
      { name: "c" },
    ] as unknown as ToolDefinition[];
    const manager = new ContextWindowManager({
      provider: makeProvider(),
      config: makeConfig(),
      conversationId: "conv-test",
      toolTokenBudget: 50,
      resolveTools: () => resolvedTools,
    });

    // WHEN a rung runs
    await manager.reduceOverflowOneRung(makeMessages(10), {
      actualTokens: null,
      allowAutoCompressLatestTurn: false,
    });

    // THEN the reducer is fed the resolved tool budget (3 tools * 1k) rather
    // than the constructor snapshot (50)
    expect(reduceCalls[0]?.config.toolTokenBudget).toBe(3_000);
  });

  test("target is the full preflight budget when the actual count is unknown", async () => {
    // GIVEN no provider-reported actual token count
    estimateReturns.push(240_000);
    reduceSteps = [makeStep(["emergency_compaction"])];
    const manager = buildManager();

    // WHEN a rung runs
    await manager.reduceOverflowOneRung(makeMessages(10), {
      actualTokens: null,
      allowAutoCompressLatestTurn: false,
    });

    // THEN the target is the uncorrected preflight budget (200k * 0.95)
    expect(reduceCalls[0]?.config.targetTokens).toBe(190_000);
  });

  test("long histories widen the safety margin", async () => {
    // GIVEN a history longer than the 50-message threshold
    estimateReturns.push(240_000);
    reduceSteps = [makeStep(["emergency_compaction"])];
    const manager = buildManager();

    // WHEN a rung runs over 60 messages with no actual-token correction
    await manager.reduceOverflowOneRung(makeMessages(60), {
      actualTokens: null,
      allowAutoCompressLatestTurn: false,
    });

    // THEN the safety margin bumps to 0.15 → preflight budget 200k * 0.85
    expect(reduceCalls[0]?.config.targetTokens).toBe(170_000);
  });

  test("forwards the policy auto-compress permission to the ladder", async () => {
    // GIVEN the overflow policy permits the terminal auto-compress rung
    estimateReturns.push(240_000);
    reduceSteps = [makeStep(["emergency_compaction"])];
    const manager = buildManager();

    // WHEN a rung runs
    await manager.reduceOverflowOneRung(makeMessages(10), {
      actualTokens: null,
      allowAutoCompressLatestTurn: true,
      overrideProfile: "fast",
    });

    // THEN the manager passes the policy decision and profile through to the
    // reducer config alongside the budget it owns
    expect(reduceCalls[0]?.config.allowAutoCompressLatestTurn).toBe(true);
    expect(reduceCalls[0]?.config.overrideProfile).toBe("fast");
    expect(reduceCalls[0]?.config.maxMiddleTierAttempts).toBe(3);
  });
});
