/**
 * Context Window Compaction Benchmark
 *
 * Measures compaction cost with a mock provider:
 * - compaction latency under threshold pressure
 * - no-op fast path for below-threshold histories
 * - token reduction below the low-watermark target budget
 * - single-pass summarization (exactly 1 call)
 */
import { describe, expect, mock, test } from "bun:test";

// The compactor reads the conversation's image attachments from the DB to
// build its manifest; with no images these return empty.
mock.module("../persistence/conversation-crud.js", () => ({
  setConversationProcessingStartedAt: () => {},
  isConversationProcessing: () => false,
  getMessages: () => [],
}));
mock.module("../persistence/attachments-store.js", () => ({
  getAttachmentMetadataForMessage: () => [],
  getAttachmentContent: () => null,
}));
mock.module("../persistence/llm-request-log-store.js", () => ({
  recordRequestLog: () => {},
}));

import { DEFAULT_CONFIG } from "../config/defaults.js";
import { resolveCallSiteConfig } from "../config/llm-resolver.js";
import { estimatePromptTokens } from "../context/token-estimator.js";
import { ContextWindowManager } from "../plugins/defaults/compaction/window-manager.js";
import type { Message, Provider } from "../providers/types.js";

// Synthetic per-turn timestamp so the model's tail_start resolves to a message
// index. Turn 10 anchors a fat verbatim tail near the front, forcing the
// deterministic forward-cut to advance to meet the low-watermark budget.
function turnTimestamp(turn: number): string {
  const hour = String(10 + Math.floor(turn / 60)).padStart(2, "0");
  const minute = String(turn % 60).padStart(2, "0");
  return `2026-05-21 (Thursday) ${hour}:${minute}:00 -05:00 (America/Chicago)`;
}

function compactionResponse(callIndex: number): string {
  return `<compaction_result>
<summary>
Compacted summary, pass ${callIndex}. Goals preserved, constraints noted.
</summary>
<key_state>
- Nothing critical pending.
</key_state>
<tail_start timestamp="${turnTimestamp(10)}" preview="[U10] User message with enough" />
</compaction_result>`;
}

function makeSummaryProvider(counter: { calls: number }): Provider {
  return {
    name: "mock",
    async sendMessage() {
      counter.calls += 1;
      return {
        content: [{ type: "text", text: compactionResponse(counter.calls) }],
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
          text: `<turn_context>\ncurrent_time: ${turnTimestamp(
            i,
          )}\n</turn_context>\n[U${i}] User message with enough content to estimate tokens. Topic ${
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
    ...resolveCallSiteConfig("mainAgent", DEFAULT_CONFIG.llm).contextWindow,
    maxInputTokens: 6000,
    targetBudgetRatio: 0.4,
    compactThreshold: 0.6,
    summaryBudgetRatio: 0.05,
  };
}

function makeManager(provider: Provider): ContextWindowManager {
  return new ContextWindowManager({
    provider,
    config: makeConfig(),
    conversationId: "conv-benchmark",
  });
}

describe("Compaction benchmark", () => {
  test("compaction with mock provider completes under 500ms", async () => {
    const counter = { calls: 0 };
    const provider = makeSummaryProvider(counter);
    const config = makeConfig();
    const manager = makeManager(provider);

    // 90 turns = 180 messages, well above 60% of 6000 = 3600 threshold
    const messages = makeLongMessages(90);
    const before = estimatePromptTokens(messages, "system prompt", {
      providerName: "mock",
    });
    // Real loader's default compaction.autoThreshold is 0.7.
    expect(before).toBeGreaterThan(config.maxInputTokens * 0.7);

    const start = performance.now();
    const result = await manager.maybeCompact(messages);
    const elapsed = performance.now() - start;

    expect(result.compacted).toBe(true);
    expect(elapsed).toBeLessThan(500);
  });

  test("below-threshold check returns in under 50ms (no-op)", async () => {
    const counter = { calls: 0 };
    const provider = makeSummaryProvider(counter);
    const manager = makeManager(provider);

    // 3 turns = 6 messages, well below threshold
    const messages = makeLongMessages(3);

    const start = performance.now();
    const result = await manager.maybeCompact(messages);
    const elapsed = performance.now() - start;

    expect(result.compacted).toBe(false);
    expect(result.reason).toBe("below auto threshold");
    expect(elapsed).toBeLessThan(50);
    expect(counter.calls).toBe(0);
  });

  test("compaction reduces tokens below target budget", async () => {
    const counter = { calls: 0 };
    const provider = makeSummaryProvider(counter);
    const config = makeConfig();
    const manager = makeManager(provider);

    const messages = makeLongMessages(90);
    const result = await manager.maybeCompact(messages);

    expect(result.compacted).toBe(true);
    expect(result.estimatedInputTokens).toBeLessThan(
      result.previousEstimatedInputTokens,
    );
    // The deterministic forward-cut drives the rebuilt history at or below the
    // low-watermark budget: maxInputTokens * (targetBudgetRatio -
    // summaryBudgetRatio).
    const targetTokens = Math.floor(
      config.maxInputTokens *
        (config.targetBudgetRatio - config.summaryBudgetRatio),
    );
    expect(result.estimatedInputTokens).toBeLessThanOrEqual(targetTokens);
  });

  test("single-pass summarization makes exactly 1 summary call", async () => {
    const counter = { calls: 0 };
    const provider = makeSummaryProvider(counter);
    const manager = makeManager(provider);

    const messages = makeLongMessages(90);
    const result = await manager.maybeCompact(messages);

    expect(result.compacted).toBe(true);
    expect(result.summaryCalls).toBe(1);
    expect(result.summaryCalls).toBe(counter.calls);
  });
});
