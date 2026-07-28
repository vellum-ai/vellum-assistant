/**
 * Coverage for the retry budget that lives inside
 * `ContextWindowManager.maybeCompact`. The orchestrator (agent loop)
 * relies on the binary `exhausted` signal — these tests pin down when
 * the manager flips it.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../daemon/conversation-registry.js", () => ({
  findConversationOrSubagent: () => ({
    systemPrompt: "you are a test assistant",
  }),
}));

// ── Module-level mock state ───────────────────────────────────────────
// Per-test mocks key off these — keeps closures simple and avoids the
// "declared after mockImplementation references it" TDZ trap.

interface CompactionRunResult {
  messages: unknown;
  compacted: boolean;
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
  summaryText: string;
  reason?: string;
  summaryFailed?: boolean;
  tailFloorReached?: boolean;
}

let runCalls: Array<{
  messages: unknown;
  previousEstimatedInputTokens: number;
  force: boolean | undefined;
  targetTokens: number | undefined;
  fixedTailStartIndex: number | undefined;
}> = [];
let runResults: CompactionRunResult[] = [];
const estimateReturns: number[] = [];

// Captured arguments from each runEmergencyCompaction invocation, so the
// emergencyCompact tests can assert the manager fills in the fields it owns.
let emergencyCalls: Record<string, unknown>[] = [];
let emergencyResult: CompactionRunResult | undefined;

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
}));

mock.module("../context/compactor.js", () => ({
  isSyntheticCompactionMessage: () => false,
  runAssistantDrivenCompaction: async (args: {
    messages: unknown;
    previousEstimatedInputTokens: number;
    force: boolean | undefined;
    targetTokens: number | undefined;
    fixedTailStartIndex: number | undefined;
  }): Promise<CompactionRunResult> => {
    runCalls.push({
      messages: args.messages,
      previousEstimatedInputTokens: args.previousEstimatedInputTokens,
      force: args.force,
      targetTokens: args.targetTokens,
      fixedTailStartIndex: args.fixedTailStartIndex,
    });
    const idx = runCalls.length - 1;
    const result = runResults[idx];
    if (!result) {
      throw new Error(
        `Mock compactor called ${runCalls.length} time(s) but only ${runResults.length} result(s) seeded`,
      );
    }
    return result;
  },
  runEmergencyCompaction: async (
    args: Record<string, unknown>,
  ): Promise<CompactionRunResult> => {
    emergencyCalls.push(args);
    if (!emergencyResult) {
      throw new Error("emergencyResult not seeded");
    }
    return emergencyResult;
  },
}));

import { ContextWindowManager } from "../plugins/defaults/compaction/window-manager.js";
import type { Message, Provider } from "../providers/types.js";

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

function compactResult(
  overrides: Partial<CompactionRunResult> = {},
): CompactionRunResult {
  return {
    messages: makeMessages(2),
    compacted: true,
    previousEstimatedInputTokens: 150_000,
    estimatedInputTokens: 50_000,
    maxInputTokens: 200_000,
    thresholdTokens: 140_000,
    compactedMessages: 5,
    compactedPersistedMessages: 5,
    summaryCalls: 1,
    summaryInputTokens: 1000,
    summaryOutputTokens: 200,
    summaryModel: "mock-model",
    summaryText: "summary",
    summaryFailed: false,
    ...overrides,
  };
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

describe("ContextWindowManager.maybeCompact retry budget", () => {
  beforeEach(() => {
    runCalls = [];
    runResults = [];
    estimateReturns.length = 0;
  });

  test("single productive pass under threshold returns without retry", async () => {
    // Estimate sequence: (1) pre-compaction = 160k forces compaction,
    // (2) post-attempt-1 recompute = 50k clears threshold.
    estimateReturns.push(160_000, 50_000);
    runResults = [compactResult({ estimatedInputTokens: 50_000 })];

    const manager = buildManager();
    const result = await manager.maybeCompact(makeMessages(10));

    expect(runCalls.length).toBe(1);
    expect(result.compacted).toBe(true);
    expect(result.exhausted).toBeUndefined();
    expect(result.estimatedInputTokens).toBe(50_000);
  });

  test("compacted but still above threshold retries until under", async () => {
    // Pre-compaction 180k → attempt-1 recompute 150k (still above
    // 140k threshold) → attempt-2 recompute 80k (under). 2 attempts
    // consumed; counters accumulate.
    estimateReturns.push(180_000, 150_000, 80_000);
    runResults = [
      compactResult({
        estimatedInputTokens: 150_000,
        compactedMessages: 6,
        summaryInputTokens: 1000,
      }),
      compactResult({
        estimatedInputTokens: 80_000,
        compactedMessages: 2,
        summaryInputTokens: 500,
      }),
    ];

    const manager = buildManager();
    const result = await manager.maybeCompact(makeMessages(10));

    expect(runCalls.length).toBe(2);
    expect(result.compactedMessages).toBe(8);
    expect(result.summaryCalls).toBe(2);
    expect(result.summaryInputTokens).toBe(1500);
    expect(result.estimatedInputTokens).toBe(80_000);
    expect(result.exhausted).toBeUndefined();
  });

  test("compacted but stuck (no shrinkage) breaks early with exhausted", async () => {
    // Pre-compaction 180k → attempt-1 165k → attempt-2 165k (didn't
    // shrink). Must break before attempt 3 even though maxAttempts=3.
    estimateReturns.push(180_000, 165_000, 165_000);
    runResults = [
      compactResult({ estimatedInputTokens: 165_000 }),
      compactResult({ estimatedInputTokens: 165_000 }),
      // Never consumed:
      compactResult({ estimatedInputTokens: 50_000 }),
    ];

    const manager = buildManager();
    const result = await manager.maybeCompact(makeMessages(10));

    expect(runCalls.length).toBe(2);
    expect(result.exhausted).toBe(true);
    expect(result.estimatedInputTokens).toBe(165_000);
  });

  test("compacted but still above threshold after maxAttempts marks exhausted", async () => {
    // Progressive shrink that never quite clears: 170k → 160k → 150k,
    // all above 140k threshold. Consumes all 3 attempts; exhausted.
    estimateReturns.push(180_000, 170_000, 160_000, 150_000);
    runResults = [
      compactResult({ estimatedInputTokens: 170_000, compactedMessages: 3 }),
      compactResult({ estimatedInputTokens: 160_000, compactedMessages: 2 }),
      compactResult({ estimatedInputTokens: 150_000, compactedMessages: 1 }),
    ];

    const manager = buildManager(3);
    const result = await manager.maybeCompact(makeMessages(10));

    expect(runCalls.length).toBe(3);
    expect(result.exhausted).toBe(true);
    expect(result.estimatedInputTokens).toBe(150_000);
    expect(result.compactedMessages).toBe(6);
  });

  test("compactor early-returns (compacted=false) → pass-through, no exhausted", async () => {
    estimateReturns.push(180_000);
    runResults = [
      compactResult({
        compacted: false,
        estimatedInputTokens: 180_000,
        compactedMessages: 0,
        summaryCalls: 0,
        reason: "no eligible messages",
      }),
    ];

    const manager = buildManager();
    const result = await manager.maybeCompact(makeMessages(10));

    expect(runCalls.length).toBe(1);
    expect(result.compacted).toBe(false);
    expect(result.exhausted).toBeUndefined();
  });

  test("maxAttempts=1 → never retries even when above threshold", async () => {
    estimateReturns.push(180_000, 165_000);
    runResults = [
      compactResult({ estimatedInputTokens: 165_000 }),
      // Never consumed:
      compactResult({ estimatedInputTokens: 100_000 }),
    ];

    const manager = buildManager(1);
    const result = await manager.maybeCompact(makeMessages(10));

    expect(runCalls.length).toBe(1);
    expect(result.exhausted).toBe(true);
    expect(result.estimatedInputTokens).toBe(165_000);
  });

  test("tailFloorReached after one pass → no futile retry, exhausted", async () => {
    // Pass 1 compacted but stayed above threshold AND the forward-cut hit the
    // tail floor — a second full-context pass would land on the same floor and
    // free nothing. The manager must NOT run attempt 2 even though maxAttempts=3.
    // Pre-compaction 180k → attempt-1 recompute 165k (above 140k threshold).
    estimateReturns.push(180_000, 165_000);
    runResults = [
      compactResult({ estimatedInputTokens: 165_000, tailFloorReached: true }),
      // Never consumed — proves no retry fired:
      compactResult({ estimatedInputTokens: 50_000 }),
    ];

    const manager = buildManager(3);
    const result = await manager.maybeCompact(makeMessages(10));

    expect(runCalls.length).toBe(1);
    expect(result.exhausted).toBe(true);
    expect(result.estimatedInputTokens).toBe(165_000);
  });

  test("tailFloorReached but already under threshold → ship, not exhausted", async () => {
    // The floor flag only forces exhaustion when still over the gate. A pass
    // that cleared the threshold ships as a clean success regardless.
    estimateReturns.push(180_000, 50_000);
    runResults = [
      compactResult({ estimatedInputTokens: 50_000, tailFloorReached: true }),
    ];

    const manager = buildManager(3);
    const result = await manager.maybeCompact(makeMessages(10));

    expect(runCalls.length).toBe(1);
    expect(result.compacted).toBe(true);
    expect(result.exhausted).toBeUndefined();
    expect(result.estimatedInputTokens).toBe(50_000);
  });

  test("tailFloorReached on a retry pass → stops the retry loop", async () => {
    // Pass 1 shrank but stayed above threshold WITHOUT hitting the floor, so a
    // retry runs. Pass 2 shrinks further, still above threshold, and this time
    // hits the floor — the loop must stop before attempt 3.
    // 180k → attempt-1 165k → attempt-2 150k (both above 140k).
    estimateReturns.push(180_000, 165_000, 150_000);
    runResults = [
      compactResult({ estimatedInputTokens: 165_000, compactedMessages: 3 }),
      compactResult({
        estimatedInputTokens: 150_000,
        compactedMessages: 2,
        tailFloorReached: true,
      }),
      // Never consumed:
      compactResult({ estimatedInputTokens: 50_000 }),
    ];

    const manager = buildManager(3);
    const result = await manager.maybeCompact(makeMessages(10));

    expect(runCalls.length).toBe(2);
    expect(result.exhausted).toBe(true);
    expect(result.estimatedInputTokens).toBe(150_000);
    expect(result.compactedMessages).toBe(5);
  });
});

describe("ContextWindowManager.maybeCompact fixed boundary", () => {
  beforeEach(() => {
    runCalls = [];
    runResults = [];
    estimateReturns.length = 0;
  });

  test("skips threshold gating and omits the target budget", async () => {
    /**
     * A fixed boundary is a user request, not a fullness response: the run
     * fires even when the estimate is far below the auto threshold and no
     * `force` option is passed, and the compactor receives no `targetTokens`
     * (the boundary is not a budget outcome) but does receive `force` so its
     * own threshold gate never trips.
     */
    // GIVEN an estimate far below the 140k threshold, then a post-compaction
    // recompute of 50k
    estimateReturns.push(10_000, 50_000);
    runResults = [
      compactResult({
        estimatedInputTokens: 50_000,
        summaryText: "fixed summary",
        compactedPersistedMessages: 5,
      }),
    ];

    // WHEN maybeCompact runs with only a fixed boundary
    const manager = buildManager();
    const result = await manager.maybeCompact(makeMessages(10), undefined, {
      fixedTailStartIndex: 4,
    });

    // THEN exactly one compactor call fired with the boundary forwarded
    expect(runCalls.length).toBe(1);
    expect(runCalls[0]!.fixedTailStartIndex).toBe(4);
    expect(runCalls[0]!.targetTokens).toBeUndefined();
    expect(runCalls[0]!.force).toBe(true);
    expect(runCalls[0]!.previousEstimatedInputTokens).toBe(10_000);

    // AND the result maps the compactor output with a recomputed estimate
    expect(result.compacted).toBe(true);
    expect(result.summaryText).toBe("fixed summary");
    expect(result.compactedPersistedMessages).toBe(5);
    expect(result.estimatedInputTokens).toBe(50_000);
    expect(result.exhausted).toBeUndefined();
  });

  test("single attempt even when the result stays above threshold", async () => {
    /**
     * The retry ladder never runs on the fixed path — a retry would
     * re-summarize past the boundary the user picked.
     */
    // GIVEN a pass that stays above the 140k threshold
    estimateReturns.push(180_000, 165_000);
    runResults = [
      compactResult({ estimatedInputTokens: 165_000 }),
      // Never consumed — proves no retry fired:
      compactResult({ estimatedInputTokens: 50_000 }),
    ];

    // WHEN maybeCompact runs with a fixed boundary and retries available
    const manager = buildManager(3);
    const result = await manager.maybeCompact(makeMessages(10), undefined, {
      force: true,
      fixedTailStartIndex: 6,
    });

    // THEN exactly one attempt ran and the result is not marked exhausted
    expect(runCalls.length).toBe(1);
    expect(result.compacted).toBe(true);
    expect(result.estimatedInputTokens).toBe(165_000);
    expect(result.exhausted).toBeUndefined();
  });

  test("failed pass returns as-is with no retry", async () => {
    /**
     * A `summaryFailed` early return passes straight through so the caller
     * can surface the failure — the manager never burns a second summary
     * call against the same user-chosen boundary.
     */
    // GIVEN a compactor pass that failed its summary call
    estimateReturns.push(180_000);
    runResults = [
      compactResult({
        compacted: false,
        summaryFailed: true,
        estimatedInputTokens: 180_000,
        compactedMessages: 0,
        summaryCalls: 1,
      }),
      // Never consumed:
      compactResult({ estimatedInputTokens: 50_000 }),
    ];

    // WHEN maybeCompact runs with a fixed boundary
    const manager = buildManager(3);
    const result = await manager.maybeCompact(makeMessages(10), undefined, {
      force: true,
      fixedTailStartIndex: 4,
    });

    // THEN the failed result passes through after a single attempt
    expect(runCalls.length).toBe(1);
    expect(result.compacted).toBe(false);
    expect(result.summaryFailed).toBe(true);
  });
});

describe("ContextWindowManager.emergencyCompact", () => {
  beforeEach(() => {
    emergencyCalls = [];
    emergencyResult = undefined;
    estimateReturns.length = 0;
  });

  test("supplies manager-owned fields and forwards only overflow inputs", async () => {
    /**
     * The manager owns provider, system prompt, token budget, conversation
     * id, compaction config, and non-persisted prefix count; the caller
     * provides only the overflow-specific inputs.
     */
    // GIVEN a manager seeded with a non-persisted prefix and a canned result
    emergencyResult = compactResult({
      compacted: true,
      compactedMessages: 40,
      summaryText: "emergency summary",
    });
    const manager = buildManager();
    manager.seedNonPersistedPrefix(3);
    const messages = makeMessages(8);
    const signal = new AbortController().signal;

    // WHEN emergency compaction runs
    const result = await manager.emergencyCompact(
      messages,
      { previousEstimatedInputTokens: 242_201, overrideProfile: "fast" },
      signal,
    );

    // THEN the manager fills its owned fields and forwards the caller inputs
    expect(emergencyCalls.length).toBe(1);
    const args = emergencyCalls[0]!;
    expect(args.conversationId).toBe("conv-test");
    expect(args.systemPrompt).toBe("you are a test assistant");
    expect(args.maxInputTokens).toBe(200_000);
    expect(args.nonPersistedPrefixCount).toBe(3);
    expect(args.tools).toBeUndefined();
    expect(args.force).toBe(true);
    expect(args.signal).toBe(signal);
    expect(args.messages).toBe(messages);
    expect(args.previousEstimatedInputTokens).toBe(242_201);
    expect(args.overrideProfile).toBe("fast");
    expect((args.provider as { name: string }).name).toBe("mock-provider");
    expect(result.summaryText).toBe("emergency summary");
  });

  test("defaults overrideProfile to null when omitted", async () => {
    /**
     * Callers that don't resolve a per-conversation profile get an explicit
     * null forwarded to the summary call.
     */
    // GIVEN a manager and a canned result
    emergencyResult = compactResult({ compacted: true });
    const manager = buildManager();

    // WHEN emergency compaction runs without an override profile
    await manager.emergencyCompact(makeMessages(6), {
      previousEstimatedInputTokens: 210_000,
    });

    // THEN overrideProfile is forwarded as null
    expect(emergencyCalls[0]!.overrideProfile).toBeNull();
  });

  test("throws when the manager has no conversation id", async () => {
    /**
     * Emergency compaction needs a conversation id for attachment and
     * timestamp lookups; a manager without one cannot run it.
     */
    // GIVEN a manager constructed without a conversation id
    const manager = new ContextWindowManager({
      provider: makeProvider(),
      config: makeConfig(),
    });

    // WHEN/THEN emergency compaction rejects without invoking the compactor
    await expect(
      manager.emergencyCompact(makeMessages(4), {
        previousEstimatedInputTokens: 210_000,
      }),
    ).rejects.toThrow(/conversationId/);
    expect(emergencyCalls.length).toBe(0);
  });
});
