/**
 * Memory Context Benchmark Fixture
 *
 * Baseline (first green run target ranges):
 * - compaction.summaryCalls: 2-6
 * - compaction.estimatedInputTokens: < previousEstimatedInputTokens
 * - recall.injectedTokens: <= computed dynamic budget
 * - recall.lexicalHits: > 0
 * - recall.recencyHits: > 0
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { DEFAULT_CONFIG } from "../config/defaults.js";
import { estimatePromptTokens } from "../context/token-estimator.js";
import { ContextWindowManager } from "../context/window-manager.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { computeRecallBudget } from "../memory/retrieval-budget.js";
import { buildMemoryRecall } from "../memory/retriever.js";
import { conversations, memorySegments, messages } from "../memory/schema.js";
import type { Message, Provider } from "../providers/types.js";

const testDir = mkdtempSync(join(tmpdir(), "memory-context-benchmark-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getSocketPath: () => join(testDir, "test.sock"),
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

function makeLongMessages(turns: number): Message[] {
  const rows: Message[] = [];
  const userTail =
    "Need fast tests, deterministic memory recall, and stable prompt budgeting in long sessions.";
  const assistantTail =
    "Tracked: compaction boundaries, recall sources, and quality constraints for incremental rollout.";
  for (let i = 0; i < turns; i++) {
    rows.push({
      role: "user",
      content: [
        {
          type: "text",
          text: `[U${i}] ${userTail} Topic ${i % 9} branch codex/memory-${i}.`,
        },
      ],
    });
    rows.push({
      role: "assistant",
      content: [
        {
          type: "text",
          text: `[A${i}] ${assistantTail} Result ${
            i % 7
          } with additional diagnostics.`,
        },
      ],
    });
  }
  return rows;
}

function makeSummaryProvider(counter: { calls: number }): Provider {
  return {
    name: "mock",
    async sendMessage() {
      counter.calls += 1;
      return {
        content: [
          {
            type: "text",
            text: `## Goals\n- Preserve rollout state\n## Constraints\n- Keep PRs small\n## Decisions\n- Call ${counter.calls}`,
          },
        ],
        model: "mock-context-model",
        usage: { inputTokens: 420, outputTokens: 85 },
        stopReason: "end_turn",
      };
    },
  };
}

function seedRecallConversation(conversationId: string, now: number): void {
  const db = getDb();
  db.insert(conversations)
    .values({
      id: conversationId,
      title: null,
      createdAt: now,
      updatedAt: now,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextSummary: null,
      contextCompactedMessageCount: 0,
      contextCompactedAt: null,
    })
    .run();

  for (let i = 0; i < 160; i++) {
    const msgId = `msg-bench-${i}`;
    const createdAt = now + i;
    const text =
      i % 5 === 0
        ? `Decision ${i}: use Bun test fixtures for memory regressions and recall ranking checks.`
        : `Progress ${i}: conversation indexing and retrieval diagnostics are stable.`;

    db.insert(messages)
      .values({
        id: msgId,
        conversationId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: JSON.stringify([{ type: "text", text }]),
        createdAt,
      })
      .run();

    db.insert(memorySegments)
      .values({
        id: `seg-bench-${i}`,
        messageId: msgId,
        conversationId,
        role: i % 2 === 0 ? "user" : "assistant",
        segmentIndex: 0,
        text,
        tokenEstimate: 20,
        scopeId: "default",
        createdAt,
        updatedAt: createdAt,
      })
      .run();
  }
}

describe("Memory context benchmark", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_item_sources");
    db.run("DELETE FROM memory_item_entities");
    db.run("DELETE FROM memory_entity_relations");
    db.run("DELETE FROM memory_entities");
    db.run("DELETE FROM memory_embeddings");
    db.run("DELETE FROM memory_summaries");
    db.run("DELETE FROM memory_items");
    db.run("DELETE FROM memory_segment_fts");
    db.run("DELETE FROM memory_segments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM memory_jobs");
    db.run("DELETE FROM memory_checkpoints");
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best effort cleanup
    }
  });

  test("long-session compaction + recall benchmark remains within expected bounds", async () => {
    const conversationId = "conv-memory-benchmark";
    const now = 1_700_500_000_000;

    seedRecallConversation(conversationId, now);

    const longMessages = makeLongMessages(90); // 180 messages
    const summaryCounter = { calls: 0 };
    const manager = new ContextWindowManager({
      provider: makeSummaryProvider(summaryCounter),
      systemPrompt: "system prompt for compaction benchmark",
      config: {
        ...DEFAULT_CONFIG.contextWindow,
        maxInputTokens: 6000,
        targetInputTokens: 3200,
        compactThreshold: 0.6,
        preserveRecentUserTurns: 8,
        chunkTokens: 1200,
      },
    });

    const compacted = await manager.maybeCompact(longMessages);
    expect(compacted.compacted).toBe(true);
    expect(compacted.summaryCalls).toBeGreaterThan(0);
    expect(compacted.summaryCalls).toBe(summaryCounter.calls);
    expect(compacted.estimatedInputTokens).toBeLessThan(
      compacted.previousEstimatedInputTokens,
    );
    expect(compacted.compactedMessages).toBeGreaterThan(0);

    const recallConfig = {
      ...DEFAULT_CONFIG,
      contextWindow: { ...DEFAULT_CONFIG.contextWindow, maxInputTokens: 6000 },
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          provider: "openai" as const,
          required: false,
        },
        retrieval: {
          ...DEFAULT_CONFIG.memory.retrieval,
          lexicalTopK: 50,
          semanticTopK: 20,
          maxInjectTokens: 750,
          reranking: {
            ...DEFAULT_CONFIG.memory.retrieval.reranking,
            enabled: false,
          },
          dynamicBudget: {
            enabled: true,
            minInjectTokens: 160,
            maxInjectTokens: 750,
            targetHeadroomTokens: 900,
          },
        },
      },
    };

    const recallBudget = computeRecallBudget({
      estimatedPromptTokens: estimatePromptTokens(
        compacted.messages,
        "system prompt for compaction benchmark",
        { providerName: "mock" },
      ),
      maxInputTokens: recallConfig.contextWindow.maxInputTokens,
      targetHeadroomTokens:
        recallConfig.memory.retrieval.dynamicBudget.targetHeadroomTokens,
      minInjectTokens:
        recallConfig.memory.retrieval.dynamicBudget.minInjectTokens,
      maxInjectTokens:
        recallConfig.memory.retrieval.dynamicBudget.maxInjectTokens,
    });

    const recall = await buildMemoryRecall(
      "What decisions did we make about Bun tests and retrieval diagnostics?",
      conversationId,
      recallConfig,
      { maxInjectTokensOverride: recallBudget },
    );

    // In CI, Qdrant/embedding providers are unavailable, so semantic search
    // fails and the retriever marks the result as degraded.  The benchmark
    // cares about compaction and lexical recall quality, not embedding
    // availability, so we do not assert on `recall.degraded`.
    expect(recall.lexicalHits).toBeGreaterThan(0);
    expect(recall.recencyHits).toBeGreaterThan(0);
    expect(recall.selectedCount).toBeGreaterThan(0);
    expect(recall.injectedTokens).toBeLessThanOrEqual(recallBudget);
    expect(recallBudget).toBeGreaterThanOrEqual(
      recallConfig.memory.retrieval.dynamicBudget.minInjectTokens,
    );
    expect(recallBudget).toBeLessThanOrEqual(
      recallConfig.memory.retrieval.dynamicBudget.maxInjectTokens,
    );
    expect(recall.injectedText).toContain("Bun test fixtures");
  });
});
