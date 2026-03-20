/**
 * Context Window Compaction Benchmark
 *
 * Measures compaction cost with a mock provider:
 * - compaction latency under threshold pressure
 * - no-op fast path for below-threshold histories
 * - token reduction below target budget
 * - single-pass summarization (exactly 1 call)
 * - severe pressure overriding cooldown
 */
import { describe, expect, mock, test } from "bun:test";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import { estimatePromptTokens } from "../context/token-estimator.js";
import { ContextWindowManager } from "../context/window-manager.js";
import type { Message, Provider } from "../providers/types.js";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, { get: () => () => {} }),
}));

function makeSummaryProvider(counter: { calls: number }): Provider {
  return {
    name: "mock",
    async sendMessage() {
      counter.calls += 1;
      return {
        content: [
          {
            type: "text",
            text: `## Goals\n- Preserve state\n## Constraints\n- Keep PRs small\n## Decisions\n- Call ${counter.calls}`,
          },
        ],
        model: "mock-model",
        usage: { inputTokens: 420, outputTokens: 85 },
        stopReason: "end_turn",
      };
    },
  };
}

function makeLongMessages(turns: number): Message[] {
  const rows: Message[] = [];
  for (let i = 0; i < turns; i++) {
    rows.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `[U${i}] User message with enough content to estimate tokens. Topic ${
            i % 9
          }.`,
        },
      ],
    });
    rows.push({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[A${i}] Assistant response with relevant content. Result ${
            i % 7
          }.`,
        },
      ],
    });
  }
  return rows;
}

function makeConfig() {
  return {
    ...DEFAULT_CONFIG.contextWindow,
    maxInputTokens: 6000,
    targetBudgetRatio: 0.58,
    compactThreshold: 0.6,
    summaryBudgetRatio: 0.05,
  };
}

describe("Compaction benchmark", () => {
  test("compaction with mock provider completes under 500ms", async () => {
    const counter = { calls: 0 };
    const provider = makeSummaryProvider(counter);
    const config = makeConfig();
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config,
    });

    // 90 turns = 180 messages, well above 60% of 6000 = 3600 threshold
    const messages = makeLongMessages(90);
    const before = estimatePromptTokens(messages, "system prompt", {
      providerName: "mock",
    });
    expect(before).toBeGreaterThan(
      config.maxInputTokens * config.compactThreshold,
    );

    const start = performance.now();
    const result = await manager.maybeCompact(messages);
    const elapsed = performance.now() - start;

    expect(result.compacted).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  test("below-threshold check returns in under 50ms (no-op)", async () => {
    const counter = { calls: 0 };
    const provider = makeSummaryProvider(counter);
    const config = makeConfig();
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config,
    });

    // 3 turns = 6 messages, well below threshold
    const messages = makeLongMessages(3);

    const start = performance.now();
    const result = await manager.maybeCompact(messages);
    const elapsed = performance.now() - start;

    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("below compaction threshold");
    expect(elapsed).toBeLessThan(50);
    expect(counter.calls).toBe(0);
  });

  test("compaction reduces tokens below target budget", async () => {
    const counter = { calls: 0 };
    const provider = makeSummaryProvider(counter);
    const config = makeConfig();
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config,
    });

    const messages = makeLongMessages(90);
    const result = await manager.maybeCompact(messages);

    expect(result.compacted).toBe(true);
    expect(result.estimatedInputTokens).toBeLessThan(
      result.previousEstimatedInputTokens,
    );
    // Target is maxInputTokens * (targetBudgetRatio - summaryBudgetRatio)
    const targetTokens = Math.floor(
      config.maxInputTokens *
        (config.targetBudgetRatio - config.summaryBudgetRatio),
    );
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(targetTokens);
  });

  test("single-pass summarization makes exactly 1 summary call", async () => {
    const counter = { calls: 0 };
    const provider = makeSummaryProvider(counter);
    const config = makeConfig();
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config,
    });

    const messages = makeLongMessages(90);
    const result = await manager.maybeCompact(messages);

    expect(result.compacted).toBe(true);
    expect(result.summaryCalls).toBe(1);
    expect(result.summaryCalls).toBe(counter.calls);
  });

  test("severe pressure triggers compaction even during cooldown", async () => {
    const counter = { calls: 0 };
    const provider = makeSummaryProvider(counter);
    // Use a tighter maxInputTokens so 90 turns exceeds the 95% severe threshold
    const config = {
      ...makeConfig(),
      maxInputTokens: 4000,
      targetBudgetRatio: 0.55,
    };
    const manager = new ContextWindowManager({
      provider,
      systemPrompt: "system prompt",
      config,
    });

    const messages = makeLongMessages(90);
    const estimated = estimatePromptTokens(messages, "system prompt", {
      providerName: "mock",
    });
    expect(estimated).toBeGreaterThan(config.maxInputTokens * 0.95);

    // Simulate being within cooldown by setting lastCompactedAt to now
    const result = await manager.maybeCompact(messages, undefined, {
      lastCompactedAt: Date.now(),
    });

    expect(result.compacted).toBe(true);
    expect(result.summaryCalls).toBeGreaterThan(0);
  });
});
