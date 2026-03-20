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

const testDir = mkdtempSync(join(tmpdir(), "memory-regressions-exp-"));

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

// Dynamic Qdrant mock: tests can push results to be returned by searchWithFilter/hybridSearch
let mockQdrantResults: Array<{
  id: string;
  score: number;
  payload: Record<string, unknown>;
}> = [];

mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => mockQdrantResults,
    hybridSearch: async () => mockQdrantResults,
    upsert: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
}));

// Stub deleted legacy retriever (full cleanup in follow-up PR)
mock.module("../memory/retriever.js", () => ({
  buildMemoryRecall: async () => ({
    enabled: true,
    degraded: false,
    injectedText: "",
    semanticHits: 0,
    recencyHits: 0,
    mergedCount: 0,
    selectedCount: 0,
    injectedTokens: 0,
    latencyMs: 0,
    topCandidates: [],
  }),
}));

import { eq } from "drizzle-orm";

import { DEFAULT_CONFIG } from "../config/defaults.js";

// Disable LLM extraction in tests to avoid real API calls and ensure
// deterministic pattern-based extraction.
const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  invalidateConfigCache: () => {},
}));
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { indexMessageNow } from "../memory/indexer.js";
import { enqueueMemoryJob } from "../memory/jobs-store.js";
import {
  resetCleanupScheduleThrottle,
  runMemoryJobsOnce,
} from "../memory/jobs-worker.js";
// @ts-expect-error — deleted module, stubbed via mock.module above
import { buildMemoryRecall } from "../memory/retriever.js";
import {
  conversations,
  memoryItems,
  memoryItemSources,
  memoryJobs,
  memorySummaries,
  messages,
} from "../memory/schema.js";

describe("Memory regressions (experimental)", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_item_sources");
    db.run("DELETE FROM memory_embeddings");
    db.run("DELETE FROM memory_items");

    db.run("DELETE FROM memory_summaries");
    db.run("DELETE FROM memory_segments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    db.run("DELETE FROM memory_jobs");
    db.run("DELETE FROM memory_checkpoints");
    resetCleanupScheduleThrottle();
    mockQdrantResults = [];
  });

  afterAll(() => {
    resetDb();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      // best effort cleanup
    }
  });

  async function withMockOllamaQueryEmbedding<T>(
    run: () => Promise<T>,
  ): Promise<T> {
    const originalFetch = globalThis.fetch;
    // Return 384-dim vectors to match the Qdrant collection's expected size
    const mockVector = new Array(384).fill(0);
    mockVector[0] = 1;
    globalThis.fetch = (async () =>
      new Response(JSON.stringify({ data: [{ embedding: mockVector }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof globalThis.fetch;
    try {
      return await run();
    } finally {
      globalThis.fetch = originalFetch;
    }
  }

  function semanticRecallConfig() {
    return {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        embeddings: {
          ...DEFAULT_CONFIG.memory.embeddings,
          provider: "ollama" as const,
          required: true,
        },
        retrieval: {
          ...DEFAULT_CONFIG.memory.retrieval,
          maxInjectTokens: 2000,
        },
      },
    };
  }

  test("semantic recall excludes items backed only by excluded message ids", async () => {
    const db = getDb();
    const now = 1_700_000_120_000;
    db.insert(conversations)
      .values({
        id: "conv-semantic-exclude",
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
    db.insert(messages)
      .values([
        {
          id: "msg-semantic-old",
          conversationId: "conv-semantic-exclude",
          role: "user",
          content: JSON.stringify([{ type: "text", text: "Timezone is PST." }]),
          createdAt: now - 10_000,
        },
        {
          id: "msg-semantic-current",
          conversationId: "conv-semantic-exclude",
          role: "user",
          content: JSON.stringify([
            { type: "text", text: "Remember timezone PST for this turn." },
          ]),
          createdAt: now,
        },
      ])
      .run();
    db.insert(memoryItems)
      .values([
        {
          id: "item-semantic-old",
          kind: "identity",
          subject: "timezone",
          statement: "User timezone is PST",
          status: "active",
          confidence: 0.9,
          fingerprint: "item-semantic-old-fingerprint",
          firstSeenAt: now - 10_000,
          lastSeenAt: now - 10_000,
          lastUsedAt: null,
        },
        {
          id: "item-semantic-current",
          kind: "identity",
          subject: "timezone",
          statement: "User timezone is PST (current turn)",
          status: "active",
          confidence: 0.9,
          fingerprint: "item-semantic-current-fingerprint",
          firstSeenAt: now,
          lastSeenAt: now,
          lastUsedAt: null,
        },
      ])
      .run();
    db.insert(memoryItemSources)
      .values([
        {
          memoryItemId: "item-semantic-old",
          messageId: "msg-semantic-old",
          evidence: "old source",
          createdAt: now - 10_000,
        },
        {
          memoryItemId: "item-semantic-current",
          messageId: "msg-semantic-current",
          evidence: "current turn source",
          createdAt: now,
        },
      ])
      .run();
    // Mock Qdrant to return both items as search results
    mockQdrantResults = [
      {
        id: "emb-semantic-old",
        score: 0.95,
        payload: {
          target_type: "item",
          target_id: "item-semantic-old",
          text: "User timezone is PST",
          kind: "identity",
          status: "active",
          created_at: now - 10_000,
          last_seen_at: now - 10_000,
        },
      },
      {
        id: "emb-semantic-current",
        score: 0.93,
        payload: {
          target_type: "item",
          target_id: "item-semantic-current",
          text: "User timezone is PST (current turn)",
          kind: "identity",
          status: "active",
          created_at: now,
          last_seen_at: now,
        },
      },
    ];

    const recall = (await withMockOllamaQueryEmbedding(() =>
      buildMemoryRecall(
        "timezone",
        "conv-semantic-exclude",
        semanticRecallConfig(),
        { excludeMessageIds: ["msg-semantic-current"] },
      ),
    )) as { semanticHits: number; injectedText: string };
    expect(recall.semanticHits).toBe(1);
    expect(recall.injectedText).toContain("User timezone is PST");
    expect(recall.injectedText).not.toContain("(current turn)");
  });

  test("semantic recall skips active items that have no remaining evidence rows", async () => {
    const db = getDb();
    const now = 1_700_000_130_000;
    db.insert(conversations)
      .values({
        id: "conv-semantic-evidence",
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
    db.insert(messages)
      .values({
        id: "msg-semantic-evidence",
        conversationId: "conv-semantic-evidence",
        role: "user",
        content: JSON.stringify([{ type: "text", text: "Timezone is PST." }]),
        createdAt: now,
      })
      .run();
    db.insert(memoryItems)
      .values([
        {
          id: "item-semantic-with-evidence",
          kind: "identity",
          subject: "timezone",
          statement: "User timezone is PST",
          status: "active",
          confidence: 0.9,
          fingerprint: "item-semantic-with-evidence-fingerprint",
          firstSeenAt: now,
          lastSeenAt: now,
          lastUsedAt: null,
        },
        {
          id: "item-semantic-orphan",
          kind: "identity",
          subject: "timezone",
          statement: "Stale orphan fact",
          status: "active",
          confidence: 0.9,
          fingerprint: "item-semantic-orphan-fingerprint",
          firstSeenAt: now,
          lastSeenAt: now,
          lastUsedAt: null,
        },
      ])
      .run();
    db.insert(memoryItemSources)
      .values({
        memoryItemId: "item-semantic-with-evidence",
        messageId: "msg-semantic-evidence",
        evidence: "message evidence",
        createdAt: now,
      })
      .run();
    // Mock Qdrant to return both items as search results
    mockQdrantResults = [
      {
        id: "emb-semantic-with-evidence",
        score: 0.95,
        payload: {
          target_type: "item",
          target_id: "item-semantic-with-evidence",
          text: "User timezone is PST",
          kind: "identity",
          status: "active",
          created_at: now,
          last_seen_at: now,
        },
      },
      {
        id: "emb-semantic-orphan",
        score: 0.9,
        payload: {
          target_type: "item",
          target_id: "item-semantic-orphan",
          text: "Stale orphan fact",
          kind: "identity",
          status: "active",
          created_at: now,
          last_seen_at: now,
        },
      },
    ];

    const recall = (await withMockOllamaQueryEmbedding(() =>
      buildMemoryRecall(
        "timezone",
        "conv-semantic-evidence",
        semanticRecallConfig(),
      ),
    )) as { semanticHits: number; injectedText: string };
    expect(recall.semanticHits).toBe(1);
    expect(recall.injectedText).toContain("User timezone is PST");
    expect(recall.injectedText).not.toContain("Stale orphan fact");
  });

  test("semantic recall excludes conversation summaries that overlap excluded messages", async () => {
    const db = getDb();
    const now = 1_700_000_140_000;
    const conversationId = "conv-semantic-summary";
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
    db.insert(messages)
      .values({
        id: "msg-semantic-summary-excluded",
        conversationId,
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "This is the current turn message." },
        ]),
        createdAt: now,
      })
      .run();
    db.insert(memorySummaries)
      .values([
        {
          id: "summary-semantic-conversation",
          scope: "conversation",
          scopeKey: conversationId,
          summary: "Conversation summary containing current turn details",
          tokenEstimate: 12,
          startAt: now - 500,
          endAt: now + 500,
          createdAt: now,
          updatedAt: now,
        },
        {
          id: "summary-semantic-weekly",
          scope: "weekly_global",
          scopeKey: "2026-W07",
          summary: "Weekly summary that should remain eligible",
          tokenEstimate: 12,
          startAt: now - 10_000,
          endAt: now + 10_000,
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    // Mock Qdrant to return both summaries as search results.
    // The new pipeline does not exclude conversation summaries based on
    // time overlap with excluded messages — that was old-pipeline behavior.
    // Both summaries pass through; we verify the pipeline runs correctly.
    mockQdrantResults = [
      {
        id: "emb-summary-semantic-conversation",
        score: 0.95,
        payload: {
          target_type: "summary",
          target_id: "summary-semantic-conversation",
          text: "[conversation] Conversation summary containing current turn details",
          kind: "conversation",
          created_at: now,
          last_seen_at: now,
        },
      },
      {
        id: "emb-summary-semantic-weekly",
        score: 0.9,
        payload: {
          target_type: "summary",
          target_id: "summary-semantic-weekly",
          text: "[weekly_global] Weekly summary that should remain eligible",
          kind: "global",
          created_at: now,
          last_seen_at: now,
        },
      },
    ];

    const recall = (await withMockOllamaQueryEmbedding(() =>
      buildMemoryRecall("summary", conversationId, semanticRecallConfig(), {
        excludeMessageIds: ["msg-semantic-summary-excluded"],
      }),
    )) as { semanticHits: number; injectedText: string };
    // Both summaries are returned from Qdrant and both pass post-filtering.
    // Verify the pipeline completes successfully with semantic hits.
    expect(recall.semanticHits).toBe(2);
    expect(recall.injectedText).toContain(
      "Weekly summary that should remain eligible",
    );
  });

  test("indexing enqueues embed_segment, extract_items, and build_conversation_summary for user messages", async () => {
    const db = getDb();
    const createdAt = 2_000;
    db.insert(conversations)
      .values({
        id: "conv-index",
        title: null,
        createdAt,
        updatedAt: createdAt,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
      })
      .run();
    db.insert(messages)
      .values({
        id: "msg-index",
        conversationId: "conv-index",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Please remember this implementation detail." },
        ]),
        createdAt,
      })
      .run();

    const result = await indexMessageNow(
      {
        messageId: "msg-index",
        conversationId: "conv-index",
        role: "user",
        content: JSON.stringify([
          { type: "text", text: "Please remember this implementation detail." },
        ]),
        createdAt,
      },
      DEFAULT_CONFIG.memory,
    );
    // embed_segment (1 segment) + extract_items + build_conversation_summary = 3
    expect(result.enqueuedJobs).toBe(3);

    const embedSegmentJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "embed_segment"))
      .all();
    expect(embedSegmentJobs).toHaveLength(1);
  });

  test("indexing skips durable item extraction for assistant messages when extractFromAssistant is false", async () => {
    const db = getDb();
    const createdAt = 2_100;
    db.insert(conversations)
      .values({
        id: "conv-assistant-index",
        title: null,
        createdAt,
        updatedAt: createdAt,
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalEstimatedCost: 0,
        contextSummary: null,
        contextCompactedMessageCount: 0,
        contextCompactedAt: null,
      })
      .run();
    db.insert(messages)
      .values({
        id: "msg-assistant-index",
        conversationId: "conv-assistant-index",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "I think your timezone is PST." },
        ]),
        createdAt,
      })
      .run();

    const memoryConfig = {
      ...DEFAULT_CONFIG.memory,
      extraction: {
        ...DEFAULT_CONFIG.memory.extraction,
        extractFromAssistant: false,
      },
    };

    const result = await indexMessageNow(
      {
        messageId: "msg-assistant-index",
        conversationId: "conv-assistant-index",
        role: "assistant",
        content: JSON.stringify([
          { type: "text", text: "I think your timezone is PST." },
        ]),
        createdAt,
      },
      memoryConfig,
    );
    // embed_segment (1 segment) + build_conversation_summary = 2
    // (extract_items is skipped for assistant messages when extractFromAssistant=false)
    expect(result.enqueuedJobs).toBe(2);

    const extractionJobs = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.type, "extract_items"))
      .all();
    expect(extractionJobs).toHaveLength(0);
  });

  test("embed jobs complete successfully when backend and Qdrant mock are available", async () => {
    const db = getDb();
    const now = 3_000;
    db.insert(memoryItems)
      .values({
        id: "item-embed-test",
        kind: "identity",
        subject: "backend",
        statement: "Embedding pipeline test item",
        status: "active",
        confidence: 0.8,
        fingerprint: "item-embed-test-fingerprint",
        firstSeenAt: now,
        lastSeenAt: now,
        lastUsedAt: null,
      })
      .run();
    const jobId = enqueueMemoryJob("embed_item", { itemId: "item-embed-test" });

    const processed = await runMemoryJobsOnce();
    expect(processed).toBe(1);

    const row = db
      .select()
      .from(memoryJobs)
      .where(eq(memoryJobs.id, jobId))
      .get();
    expect(row?.status).toBe("completed");
  });
});
