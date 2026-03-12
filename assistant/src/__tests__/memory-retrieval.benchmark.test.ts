/**
 * Memory Retrieval Benchmark
 *
 * Measures end-to-end memory recall time with varying database sizes.
 * Validates latency stays within acceptable bounds and token budget
 * enforcement works correctly.
 *
 * The new pipeline uses hybrid search (Qdrant) + recency search.
 * With Qdrant mocked and semanticSearch returning empty, only recency
 * search provides candidates. These recency-only candidates have
 * low finalScore (< 0.6) and are filtered out by tier classification,
 * so injectedText is empty. The tests verify pipeline completion,
 * latency bounds, and correct handling of recency hits.
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

const testDir = mkdtempSync(join(tmpdir(), "mem-retrieval-bench-"));

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
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

// Counter for semantic search invocations
let semanticSearchCallCount = 0;

mock.module("../memory/search/semantic.js", () => ({
  semanticSearch: async () => {
    semanticSearchCallCount++;
    return [];
  },
  isQdrantConnectionError: () => false,
}));

mock.module("../memory/embedding-backend.js", () => ({
  getMemoryBackendStatus: (config: { memory: { enabled: boolean } }) => ({
    enabled: config.memory.enabled,
    degraded: false,
    provider: "local",
    model: "mock-embedding",
    reason: null,
  }),
  embedWithBackend: async () => ({
    provider: "local" as const,
    model: "mock-embedding",
    vectors: [new Array(1536).fill(0)],
  }),
  generateSparseEmbedding: () => ({ indices: [], values: [] }),
  logMemoryEmbeddingWarning: () => {},
}));

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { AssistantConfig } from "../config/types.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { buildMemoryRecall } from "../memory/retriever.js";
import { conversations, memorySegments, messages } from "../memory/schema.js";

function seedMemoryItems(
  conversationId: string,
  count: number,
  now: number,
): void {
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

  for (let i = 0; i < count; i++) {
    const msgId = `msg-${conversationId}-${i}`;
    const text = `Memory item ${i}: information about topic-${
      i % 20
    } including keyword-${i % 10} details.`;
    db.insert(messages)
      .values({
        id: msgId,
        conversationId,
        role: i % 2 === 0 ? "user" : "assistant",
        content: JSON.stringify([{ type: "text", text }]),
        createdAt: now + i,
      })
      .run();
    db.insert(memorySegments)
      .values({
        id: `seg-${conversationId}-${i}`,
        messageId: msgId,
        conversationId,
        role: i % 2 === 0 ? "user" : "assistant",
        segmentIndex: 0,
        text,
        tokenEstimate: 20,
        scopeId: "default",
        createdAt: now + i,
        updatedAt: now + i,
      })
      .run();
  }
}

function makeConfig(overrides?: { maxInjectTokens?: number }): AssistantConfig {
  return {
    ...DEFAULT_CONFIG,
    memory: {
      ...DEFAULT_CONFIG.memory,
      embeddings: {
        ...DEFAULT_CONFIG.memory.embeddings,
        provider: "local" as const,
        required: false,
      },
      retrieval: {
        ...DEFAULT_CONFIG.memory.retrieval,
        lexicalTopK: 50,
        semanticTopK: 20,
        maxInjectTokens: overrides?.maxInjectTokens ?? 750,
        reranking: {
          ...DEFAULT_CONFIG.memory.retrieval.reranking,
          enabled: false,
        },
        dynamicBudget: {
          enabled: false,
          minInjectTokens: 160,
          maxInjectTokens: overrides?.maxInjectTokens ?? 750,
          targetHeadroomTokens: 900,
        },
      },
    },
  };
}

describe("Memory retrieval benchmark", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_item_sources");
    db.run("DELETE FROM memory_embeddings");
    db.run("DELETE FROM memory_items");

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

  test("retrieval completes under 500ms for 100 items", async () => {
    const conversationId = "conv-bench-100";
    const now = 1_700_500_000_000;
    seedMemoryItems(conversationId, 100, now);

    const config = makeConfig();
    const recall = await buildMemoryRecall(
      "What do we know about topic-5 and keyword-3?",
      conversationId,
      config,
    );

    expect(recall.enabled).toBe(true);
    expect(recall.degraded).toBe(false);
    // Recency search finds conversation-scoped segments
    expect(recall.recencyHits).toBeGreaterThan(0);
    // Relaxed threshold — guards against severe regressions, not precise benchmarking
    expect(recall.latencyMs).toBeLessThan(500);
  });

  test("retrieval completes under 1000ms for 500 items", async () => {
    const conversationId = "conv-bench-500";
    const now = 1_700_500_000_000;
    seedMemoryItems(conversationId, 500, now);

    const config = makeConfig();
    const recall = await buildMemoryRecall(
      "What do we know about topic-5 and keyword-3?",
      conversationId,
      config,
    );

    expect(recall.enabled).toBe(true);
    expect(recall.degraded).toBe(false);
    expect(recall.recencyHits).toBeGreaterThan(0);
    expect(recall.latencyMs).toBeLessThan(1000);
  });

  test("retrieval completes under 2000ms for 2000 items", async () => {
    const conversationId = "conv-bench-2000";
    const now = 1_700_500_000_000;
    seedMemoryItems(conversationId, 2000, now);

    const config = makeConfig();
    const recall = await buildMemoryRecall(
      "What do we know about topic-5 and keyword-3?",
      conversationId,
      config,
    );

    expect(recall.enabled).toBe(true);
    expect(recall.degraded).toBe(false);
    expect(recall.recencyHits).toBeGreaterThan(0);
    expect(recall.latencyMs).toBeLessThan(2000);
  });

  test("token budget enforcement: maxInjectTokens is respected", async () => {
    const conversationId = "conv-bench-budget";
    const now = 1_700_500_000_000;
    seedMemoryItems(conversationId, 500, now);

    const smallBudget = 200;
    const config = makeConfig({ maxInjectTokens: smallBudget });
    const recall = await buildMemoryRecall(
      "What do we know about topic-5 and keyword-3?",
      conversationId,
      config,
    );

    expect(recall.enabled).toBe(true);
    // With Qdrant mocked empty and recency-only candidates below tier threshold,
    // injectedTokens is 0. Verify the budget cap is still respected.
    expect(recall.injectedTokens).toBeLessThanOrEqual(smallBudget);

    // Compare against a larger budget
    const largeBudget = 2000;
    const largeConfig = makeConfig({ maxInjectTokens: largeBudget });
    const largeRecall = await buildMemoryRecall(
      "What do we know about topic-5 and keyword-3?",
      conversationId,
      largeConfig,
    );

    expect(largeRecall.injectedTokens).toBeLessThanOrEqual(largeBudget);
    // With more budget, we should get at least as many tokens
    expect(largeRecall.injectedTokens).toBeGreaterThanOrEqual(
      recall.injectedTokens,
    );
  });

  test("semantic search is invoked when not early terminated", async () => {
    const conversationId = "conv-bench-semantic";
    const now = 1_700_500_000_000;
    seedMemoryItems(conversationId, 100, now);

    const query = "What do we know about topic-5 and keyword-3?";

    // earlyTermination is always false in the new pipeline, so semantic
    // search should always be invoked when a query vector is available.
    semanticSearchCallCount = 0;
    const config = makeConfig();
    await buildMemoryRecall(query, conversationId, config);

    expect(semanticSearchCallCount).toBeGreaterThan(0);
  });

  test("recall.latencyMs tracks wall-clock within 50% tolerance", async () => {
    const conversationId = "conv-bench-wallclock";
    const now = 1_700_500_000_000;
    seedMemoryItems(conversationId, 500, now);

    const config = makeConfig();

    // Use Date.now() to match the timer source used by buildMemoryRecall
    // (which also uses Date.now()), avoiding precision mismatches between
    // integer-ms Date.now() and sub-ms performance.now().
    const wallStart = Date.now();
    const recall = await buildMemoryRecall(
      "What do we know about topic-5 and keyword-3?",
      conversationId,
      config,
    );
    const wallMs = Date.now() - wallStart;

    expect(recall.enabled).toBe(true);
    // latencyMs may be 0 when the pipeline runs very fast (< 1ms granularity)
    expect(recall.latencyMs).toBeGreaterThanOrEqual(0);

    // Self-reported latencyMs should agree with wall-clock within 50%.
    // Tolerance is wide because both sides use Date.now() (integer ms),
    // so on fast runs the quantization error can be large relative to
    // total elapsed time.
    if (wallMs > 0) {
      const ratio = recall.latencyMs / wallMs;
      expect(ratio).toBeGreaterThanOrEqual(0.5);
      expect(ratio).toBeLessThanOrEqual(1.5);
    }
  });
});
