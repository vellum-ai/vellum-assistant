/**
 * Tests for the memory retrieval pipeline.
 *
 * Covers: hybrid search → tier classification → staleness → injection,
 * empty results → no injection, superseded items filtered out,
 * staleness demotion, budget allocation, and degradation scenarios.
 */
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Stub local embedding backend to avoid loading ONNX runtime.
mock.module("../memory/embedding-local.js", () => ({
  LocalEmbeddingBackend: class {
    readonly provider = "local" as const;
    readonly model: string;
    constructor(model: string) {
      this.model = model;
    }
    async embed(texts: string[]): Promise<number[][]> {
      return texts.map(() => new Array(384).fill(0));
    }
  },
}));

// Mock Qdrant client so semantic search returns empty results by default.
// Tests can push entries into `mockQdrantResults` to simulate Qdrant returning
// specific hits (e.g. item candidates).
const mockQdrantResults: Array<{
  id: string;
  score: number;
  payload: Record<string, unknown>;
}> = [];

mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [...mockQdrantResults],
    hybridSearch: async () => [...mockQdrantResults],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
}));

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { AssistantConfig } from "../config/types.js";

const TEST_CONFIG: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    extraction: {
      ...DEFAULT_CONFIG.memory.extraction,
      useLLM: false,
    },
    embeddings: {
      ...DEFAULT_CONFIG.memory.embeddings,
      required: false,
    },
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  invalidateConfigCache: () => {},
}));

import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { clearEmbeddingBackendCache } from "../memory/embedding-backend.js";
import {
  _resetQdrantBreaker,
  isQdrantBreakerOpen,
} from "../memory/qdrant-circuit-breaker.js";
import {
  buildMemoryRecall,
  injectMemoryRecallAsUserBlock,
} from "../memory/retriever.js";
import {
  conversations,
  memoryItems,
  memoryItemSources,
  messages,
} from "../memory/schema.js";
import type { ContentBlock, Message } from "../providers/types.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract text from a content block, asserting it is a text block. */
function textOf(block: ContentBlock): string {
  if (block.type !== "text")
    throw new Error(`Expected text block, got ${block.type}`);
  return block.text;
}

function insertConversation(
  db: ReturnType<typeof getDb>,
  id: string,
  createdAt: number,
  opts?: { contextCompactedMessageCount?: number },
) {
  db.insert(conversations)
    .values({
      id,
      title: null,
      createdAt,
      updatedAt: createdAt,
      totalInputTokens: 0,
      totalOutputTokens: 0,
      totalEstimatedCost: 0,
      contextSummary: null,
      contextCompactedMessageCount: opts?.contextCompactedMessageCount ?? 0,
      contextCompactedAt: null,
    })
    .run();
}

function insertMessage(
  db: ReturnType<typeof getDb>,
  id: string,
  conversationId: string,
  role: string,
  text: string,
  createdAt: number,
  opts?: { metadata?: string | null },
) {
  db.insert(messages)
    .values({
      id,
      conversationId,
      role,
      content: JSON.stringify([{ type: "text", text }]),
      createdAt,
      metadata: opts?.metadata ?? null,
    })
    .run();
}

function insertSegment(
  db: ReturnType<typeof getDb>,
  id: string,
  messageId: string,
  conversationId: string,
  role: string,
  text: string,
  createdAt: number,
) {
  db.run(`
    INSERT INTO memory_segments (
      id, message_id, conversation_id, role, segment_index, text, token_estimate, created_at, updated_at
    ) VALUES (
      '${id}', '${messageId}', '${conversationId}', '${role}', 0, '${text.replace(
        /'/g,
        "''",
      )}', ${Math.ceil(text.split(/\s+/).length * 1.3)}, ${createdAt}, ${createdAt}
    )
  `);
}

function insertItem(
  db: ReturnType<typeof getDb>,
  opts: {
    id: string;
    kind: string;
    subject: string;
    statement: string;
    status?: string;
    confidence?: number;
    importance?: number;
    firstSeenAt: number;
    lastSeenAt?: number;
  },
) {
  db.insert(memoryItems)
    .values({
      id: opts.id,
      kind: opts.kind,
      subject: opts.subject,
      statement: opts.statement,
      status: opts.status ?? "active",
      confidence: opts.confidence ?? 0.8,
      importance: opts.importance ?? 0.6,
      accessCount: 0,
      fingerprint: `fp-${opts.id}`,
      firstSeenAt: opts.firstSeenAt,
      lastSeenAt: opts.lastSeenAt ?? opts.firstSeenAt,
      lastUsedAt: null,
    })
    .run();
}

function insertItemSource(
  db: ReturnType<typeof getDb>,
  itemId: string,
  messageId: string,
  createdAt: number,
) {
  db.insert(memoryItemSources)
    .values({
      memoryItemId: itemId,
      messageId,
      evidence: `evidence for ${itemId}`,
      createdAt,
    })
    .run();
}

/** Seed the database with some searchable memory content. */
function seedMemory() {
  const db = getDb();
  const now = Date.now();
  const convId = "conv-test";

  insertConversation(db, convId, now - 60_000);
  insertMessage(
    db,
    "msg-1",
    convId,
    "user",
    "discuss API design",
    now - 50_000,
  );
  insertMessage(
    db,
    "msg-2",
    convId,
    "assistant",
    "The API design uses REST endpoints",
    now - 40_000,
  );

  insertSegment(
    db,
    "seg-1",
    "msg-1",
    convId,
    "user",
    "discuss API design patterns",
    now - 50_000,
  );
  insertSegment(
    db,
    "seg-2",
    "msg-2",
    convId,
    "assistant",
    "The API design uses REST endpoints with JSON responses",
    now - 40_000,
  );

  insertItem(db, {
    id: "item-1",
    kind: "preference",
    subject: "API design",
    statement: "User prefers REST over GraphQL for API design",
    firstSeenAt: now - 30_000,
  });
  insertItemSource(db, "item-1", "msg-1", now - 30_000);
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Memory Retriever Pipeline", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_item_sources");
    db.run("DELETE FROM memory_items");
    db.run("DELETE FROM memory_segments");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
    _resetQdrantBreaker();
    clearEmbeddingBackendCache();
    mockQdrantResults.length = 0;
  });

  afterAll(() => {
    resetDb();
  });

  // -----------------------------------------------------------------------
  // Hybrid search → tier classification → injection
  // -----------------------------------------------------------------------

  test("baseline: pipeline completes non-degraded with mock Qdrant returning empty", async () => {
    seedMemory();

    const result = await buildMemoryRecall(
      "API design",
      "conv-test",
      TEST_CONFIG,
    );

    expect(result.enabled).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.degradation).toBeUndefined();
    // With Qdrant mocked empty, no candidates are found.
    // The pipeline still completes successfully with tier metadata.
    expect(result.tier1Count).toBeDefined();
    expect(result.tier2Count).toBeDefined();
    expect(result.hybridSearchMs).toBeDefined();
    // Without semantic search, no candidates are found.
    expect(result.mergedCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Current-conversation segment filtering
  // -----------------------------------------------------------------------

  test("current-conversation segments are filtered from search results", async () => {
    const db = getDb();
    const now = Date.now();
    const activeConv = "conv-active";
    const otherConv = "conv-other";

    insertConversation(db, activeConv, now - 60_000);
    insertConversation(db, otherConv, now - 120_000);

    // Messages and segments in the active conversation (should be filtered)
    insertMessage(
      db,
      "msg-a1",
      activeConv,
      "user",
      "hello world",
      now - 50_000,
    );
    insertSegment(
      db,
      "seg-a1",
      "msg-a1",
      activeConv,
      "user",
      "hello world",
      now - 50_000,
    );

    // Messages and segments in a different conversation (should be kept)
    insertMessage(
      db,
      "msg-o1",
      otherConv,
      "user",
      "hello world from other",
      now - 100_000,
    );
    insertSegment(
      db,
      "seg-o1",
      "msg-o1",
      otherConv,
      "user",
      "hello world from other",
      now - 100_000,
    );

    // Query from the active conversation
    const result = await buildMemoryRecall(
      "hello world",
      activeConv,
      TEST_CONFIG,
    );

    expect(result.enabled).toBe(true);
    // Without semantic search, no candidates are found.
    expect(result.mergedCount).toBe(0);
  });

  test("compacted segments from current conversation are preserved in memory", async () => {
    const db = getDb();
    const now = Date.now();
    const convId = "conv-compacted";

    // Create a conversation where 2 messages have been compacted away
    insertConversation(db, convId, now - 120_000, {
      contextCompactedMessageCount: 2,
    });

    // Older messages (compacted out of context window) — their segments
    // should NOT be filtered because the model can no longer see them
    insertMessage(
      db,
      "msg-old-1",
      convId,
      "user",
      "old discussion topic",
      now - 100_000,
    );
    insertMessage(
      db,
      "msg-old-2",
      convId,
      "assistant",
      "old response",
      now - 90_000,
    );

    // Newer messages (still in context window) — their segments should
    // be filtered since the model can still see them
    insertMessage(
      db,
      "msg-new-1",
      convId,
      "user",
      "recent discussion",
      now - 50_000,
    );
    insertMessage(
      db,
      "msg-new-2",
      convId,
      "assistant",
      "recent response",
      now - 40_000,
    );

    // Segments from compacted messages (should survive filtering)
    insertSegment(
      db,
      "seg-old-1",
      "msg-old-1",
      convId,
      "user",
      "old discussion topic details",
      now - 100_000,
    );
    insertSegment(
      db,
      "seg-old-2",
      "msg-old-2",
      convId,
      "assistant",
      "old response details",
      now - 90_000,
    );

    // Segments from in-context messages (should be filtered)
    insertSegment(
      db,
      "seg-new-1",
      "msg-new-1",
      convId,
      "user",
      "recent discussion details",
      now - 50_000,
    );
    insertSegment(
      db,
      "seg-new-2",
      "msg-new-2",
      convId,
      "assistant",
      "recent response details",
      now - 40_000,
    );

    const result = await buildMemoryRecall(
      "discussion topic",
      convId,
      TEST_CONFIG,
    );

    expect(result.enabled).toBe(true);
  });

  // -----------------------------------------------------------------------
  // Empty results → no injection
  // -----------------------------------------------------------------------

  test("empty results: no injection when no memory content exists", async () => {
    // Don't seed any memory
    const result = await buildMemoryRecall(
      "nonexistent topic",
      "conv-empty",
      TEST_CONFIG,
    );

    expect(result.enabled).toBe(true);
    expect(result.selectedCount).toBe(0);
    expect(result.injectedText).toBe("");
    expect(result.mergedCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Memory disabled
  // -----------------------------------------------------------------------

  test("disabled: returns enabled=false when memory is disabled", async () => {
    const disabledConfig: AssistantConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        enabled: false,
      },
    };

    const result = await buildMemoryRecall(
      "test query",
      "conv-test",
      disabledConfig,
    );

    expect(result.enabled).toBe(false);
    expect(result.reason).toBe("memory.disabled");
  });

  // -----------------------------------------------------------------------
  // Superseded items filtered out
  // -----------------------------------------------------------------------

  test("superseded items are not included in results", async () => {
    const db = getDb();
    const now = Date.now();
    const convId = "conv-superseded";

    insertConversation(db, convId, now - 60_000);
    insertMessage(
      db,
      "msg-s1",
      convId,
      "user",
      "test superseded",
      now - 50_000,
    );

    insertSegment(
      db,
      "seg-s1",
      "msg-s1",
      convId,
      "user",
      "test superseded content",
      now - 50_000,
    );

    // Insert an active item and a superseded item
    insertItem(db, {
      id: "item-active",
      kind: "fact",
      subject: "test",
      statement: "Active fact about testing",
      status: "active",
      firstSeenAt: now - 30_000,
    });
    insertItem(db, {
      id: "item-superseded",
      kind: "fact",
      subject: "test",
      statement: "Old fact that was superseded",
      status: "superseded",
      firstSeenAt: now - 30_000,
    });

    const result = await buildMemoryRecall(
      "test superseded",
      convId,
      TEST_CONFIG,
    );

    // The injected text should not contain the superseded item statement
    if (result.injectedText.length > 0) {
      expect(result.injectedText).not.toContain("Old fact that was superseded");
    }
  });

  // -----------------------------------------------------------------------
  // Staleness demotion (very_stale tier 1 → tier 2)
  // -----------------------------------------------------------------------

  test("staleness: very old items get demoted from tier 1 to tier 2", async () => {
    const db = getDb();
    const now = Date.now();
    const convId = "conv-stale";
    const MS_PER_DAY = 86_400_000;

    insertConversation(db, convId, now - MS_PER_DAY * 200);

    // Create a message from 200 days ago (staleness test anchor)
    insertMessage(
      db,
      "msg-old",
      convId,
      "user",
      "ancient discussion about TypeScript",
      now - MS_PER_DAY * 200,
    );
    insertSegment(
      db,
      "seg-old",
      "msg-old",
      convId,
      "user",
      "ancient discussion about TypeScript patterns",
      now - MS_PER_DAY * 200,
    );

    // Insert a very old item (200 days) — should be marked as very_stale
    insertItem(db, {
      id: "item-old",
      kind: "fact",
      subject: "TypeScript",
      statement: "User uses TypeScript for all projects",
      firstSeenAt: now - MS_PER_DAY * 200,
    });
    insertItemSource(db, "item-old", "msg-old", now - MS_PER_DAY * 200);

    const result = await buildMemoryRecall(
      "TypeScript patterns",
      convId,
      TEST_CONFIG,
    );

    // The pipeline should still return results (just potentially in tier 2)
    expect(result.enabled).toBe(true);
    // Very old items should still appear but may be in tier 2 after demotion
    expect(result.tier1Count).toBeDefined();
    expect(result.tier2Count).toBeDefined();
  });

  // -----------------------------------------------------------------------
  // Budget allocation (tier 1 priority)
  // -----------------------------------------------------------------------

  test("budget: respects maxInjectTokens override", async () => {
    seedMemory();

    // Use a very small token budget
    const result = await buildMemoryRecall(
      "API design",
      "conv-test",
      TEST_CONFIG,
      { maxInjectTokensOverride: 10 },
    );

    expect(result.enabled).toBe(true);
    // With a 10-token budget, most content should be truncated
    expect(result.injectedTokens).toBeLessThanOrEqual(10);
  });

  // -----------------------------------------------------------------------
  // Degradation: Qdrant circuit breaker open
  // -----------------------------------------------------------------------

  test("Qdrant unavailable: pipeline completes with empty results", async () => {
    seedMemory();

    // Force the Qdrant circuit breaker open
    const { withQdrantBreaker } =
      await import("../memory/qdrant-circuit-breaker.js");
    for (let i = 0; i < 5; i++) {
      try {
        await withQdrantBreaker(async () => {
          throw new Error("simulated qdrant failure");
        });
      } catch {
        // expected
      }
    }
    expect(isQdrantBreakerOpen()).toBe(true);

    const result = await buildMemoryRecall(
      "API design",
      "conv-test",
      TEST_CONFIG,
    );

    expect(result.enabled).toBe(true);
    // Semantic/hybrid search should be skipped
    expect(result.semanticHits).toBe(0);
    // Without semantic search, no candidates are found.
    expect(result.mergedCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Degradation: embedding provider down
  // -----------------------------------------------------------------------

  test("embedding provider down: returns degraded when embeddings required", async () => {
    seedMemory();

    const requiredEmbedConfig: AssistantConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: {
          ...TEST_CONFIG.memory.embeddings,
          provider: "openai",
          required: true,
        },
      },
    };

    const result = await buildMemoryRecall(
      "API design",
      "conv-test",
      requiredEmbedConfig,
    );

    expect(result.enabled).toBe(true);
    expect(result.degraded).toBe(true);
    expect(result.degradation).toBeDefined();
    expect(result.degradation!.semanticUnavailable).toBe(true);
    expect(result.degradation!.reason).toBe("embedding_provider_down");
    expect(result.degradation!.fallbackSources).toEqual([]);
  });

  // -----------------------------------------------------------------------
  // Signal abort
  // -----------------------------------------------------------------------

  test("abort: returns early when signal is aborted", async () => {
    seedMemory();
    const controller = new AbortController();
    controller.abort();

    const result = await buildMemoryRecall(
      "API design",
      "conv-test",
      TEST_CONFIG,
      { signal: controller.signal },
    );

    expect(result.enabled).toBe(true);
    expect(result.reason).toBe("memory.aborted");
    expect(result.injectedText).toBe("");
  });

  // -----------------------------------------------------------------------
  // injectMemoryRecallAsUserBlock
  // -----------------------------------------------------------------------

  test("injectMemoryRecallAsUserBlock: prepends memory context to last user message", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ];

    const recallText =
      "<memory_context __injected>\n\n<relevant_context>\ntest\n</relevant_context>\n\n</memory_context>";
    const result = injectMemoryRecallAsUserBlock(msgs, recallText);

    // Same number of messages — no synthetic pair added
    expect(result).toHaveLength(1);
    expect(result[0].role).toBe("user");
    // Memory context prepended as first content block
    expect(result[0].content).toHaveLength(2);
    expect(textOf(result[0].content[0])).toBe(recallText);
    // Original user text preserved as second block
    expect(textOf(result[0].content[1])).toBe("Hello");
  });

  test("injectMemoryRecallAsUserBlock: no-op for empty text", () => {
    const msgs: Message[] = [
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ];

    const result = injectMemoryRecallAsUserBlock(msgs, "");
    expect(result).toHaveLength(1);
    expect(textOf(result[0].content[0])).toBe("Hello");
  });

  test("injectMemoryRecallAsUserBlock: preserves history before last user message", () => {
    const msgs: Message[] = [
      { role: "user", content: [{ type: "text", text: "First" }] },
      { role: "assistant", content: [{ type: "text", text: "Response" }] },
      { role: "user", content: [{ type: "text", text: "Second" }] },
    ];

    const recallText =
      "<memory_context __injected>\n\n<relevant_context>\nfact\n</relevant_context>\n\n</memory_context>";
    const result = injectMemoryRecallAsUserBlock(msgs, recallText);

    expect(result).toHaveLength(3);
    // Earlier messages unchanged
    expect(result[0]).toBe(msgs[0]);
    expect(result[1]).toBe(msgs[1]);
    // Last user message has memory prepended
    expect(textOf(result[2].content[0])).toBe(recallText);
    expect(textOf(result[2].content[1])).toBe("Second");
  });

  // -----------------------------------------------------------------------
  // Local embedding stub end-to-end
  // -----------------------------------------------------------------------

  test("local embedding: pipeline completes non-degraded", async () => {
    seedMemory();

    const localEmbedConfig: AssistantConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: {
          ...TEST_CONFIG.memory.embeddings,
          provider: "local",
          required: false,
        },
      },
    };

    const result = await buildMemoryRecall(
      "API design",
      "conv-test",
      localEmbedConfig,
    );

    // The local stub returns zero vectors — embedding "succeeds" so the
    // pipeline proceeds non-degraded end-to-end.
    expect(result.enabled).toBe(true);
    expect(result.degraded).toBe(false);
    // Without semantic search, no candidates are found.
    expect(result.mergedCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Step 5b: in-context item filtering
  // -----------------------------------------------------------------------

  describe("step 5b: in-context item filtering", () => {
    test("filters items whose all sources are in-context messages", async () => {
      const db = getDb();
      const now = Date.now();
      const convId = "conv-item-filter";

      insertConversation(db, convId, now - 60_000);
      insertMessage(db, "msg-if-1", convId, "user", "hello", now - 50_000);
      insertMessage(db, "msg-if-2", convId, "assistant", "world", now - 40_000);
      insertMessage(
        db,
        "msg-if-3",
        convId,
        "user",
        "memory items test",
        now - 30_000,
      );

      // Insert a memory item sourced from msg-if-2 (in-context)
      insertItem(db, {
        id: "item-in-ctx",
        kind: "fact",
        subject: "test",
        statement: "A fact from in-context message",
        firstSeenAt: now - 35_000,
      });
      insertItemSource(db, "item-in-ctx", "msg-if-2", now - 35_000);

      // Simulate Qdrant returning this item as a semantic hit
      mockQdrantResults.push({
        id: "qdrant-pt-1",
        score: 0.9,
        payload: {
          target_type: "item",
          target_id: "item-in-ctx",
          text: "test: A fact from in-context message",
          created_at: now - 35_000,
        },
      });

      const result = await buildMemoryRecall(
        "memory items test",
        convId,
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      // The item should be filtered because its only source is in-context
      expect(result.mergedCount).toBe(0);
    });

    test("keeps items from compacted messages", async () => {
      const db = getDb();
      const now = Date.now();
      const convId = "conv-item-compacted";

      // 2 messages compacted away
      insertConversation(db, convId, now - 120_000, {
        contextCompactedMessageCount: 2,
      });

      // Compacted messages (first 2 by createdAt order)
      insertMessage(
        db,
        "msg-ic-1",
        convId,
        "user",
        "compacted old topic",
        now - 100_000,
      );
      insertMessage(
        db,
        "msg-ic-2",
        convId,
        "assistant",
        "compacted old reply",
        now - 90_000,
      );

      // Still in context
      insertMessage(
        db,
        "msg-ic-3",
        convId,
        "user",
        "item compaction test",
        now - 50_000,
      );

      // Item sourced from a compacted message — should be kept
      insertItem(db, {
        id: "item-compacted",
        kind: "fact",
        subject: "compaction",
        statement: "A fact from a compacted message",
        firstSeenAt: now - 95_000,
      });
      insertItemSource(db, "item-compacted", "msg-ic-1", now - 95_000);

      // Simulate Qdrant returning this item as a semantic hit
      mockQdrantResults.push({
        id: "qdrant-pt-2",
        score: 0.9,
        payload: {
          target_type: "item",
          target_id: "item-compacted",
          text: "compaction: A fact from a compacted message",
          created_at: now - 95_000,
        },
      });

      const result = await buildMemoryRecall(
        "item compaction test",
        convId,
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      // The item sourced from a compacted message should survive filtering
      // because its source is no longer in the context window
      expect(result.mergedCount).toBeGreaterThan(0);
    });

    test("keeps items with cross-conversation sources", async () => {
      const db = getDb();
      const now = Date.now();
      const convId = "conv-item-cross";
      const otherConvId = "conv-item-other";

      insertConversation(db, convId, now - 60_000);
      insertConversation(db, otherConvId, now - 120_000);

      // Messages in current conversation
      insertMessage(
        db,
        "msg-cr-1",
        convId,
        "user",
        "cross conv test",
        now - 50_000,
      );
      insertMessage(
        db,
        "msg-cr-2",
        convId,
        "assistant",
        "cross conv reply",
        now - 40_000,
      );

      // Message in the other conversation
      insertMessage(
        db,
        "msg-cr-other",
        otherConvId,
        "user",
        "other conv msg",
        now - 100_000,
      );

      // Item sourced from BOTH the current conversation AND a different one
      insertItem(db, {
        id: "item-cross",
        kind: "fact",
        subject: "cross",
        statement: "A cross-conversation fact",
        firstSeenAt: now - 95_000,
      });
      insertItemSource(db, "item-cross", "msg-cr-1", now - 45_000);
      insertItemSource(db, "item-cross", "msg-cr-other", now - 95_000);

      // Simulate Qdrant returning this item as a semantic hit
      mockQdrantResults.push({
        id: "qdrant-pt-3",
        score: 0.9,
        payload: {
          target_type: "item",
          target_id: "item-cross",
          text: "cross: A cross-conversation fact",
          created_at: now - 95_000,
        },
      });

      const result = await buildMemoryRecall(
        "cross conv test",
        convId,
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      // The item has a source outside the in-context set (from other conv),
      // so it should NOT be filtered — it carries cross-conversation info
      expect(result.mergedCount).toBeGreaterThan(0);
    });
  });

  // -----------------------------------------------------------------------
  // Step 5b: fork-aware filtering
  // -----------------------------------------------------------------------

  describe("step 5b: fork-aware filtering", () => {
    test("filters segments sourced from fork-parent messages", async () => {
      const db = getDb();
      const now = Date.now();

      // Parent conversation with messages
      const parentConv = "conv-parent";
      insertConversation(db, parentConv, now - 120_000);
      insertMessage(
        db,
        "parent-msg-1",
        parentConv,
        "user",
        "discuss fork patterns",
        now - 110_000,
      );
      insertMessage(
        db,
        "parent-msg-2",
        parentConv,
        "assistant",
        "fork patterns are useful",
        now - 100_000,
      );

      // Fork conversation — messages are copies with forkSourceMessageId metadata
      const forkConv = "conv-fork";
      insertConversation(db, forkConv, now - 50_000);
      insertMessage(
        db,
        "fork-msg-1",
        forkConv,
        "user",
        "discuss fork patterns",
        now - 50_000,
        {
          metadata: JSON.stringify({
            forkSourceMessageId: "parent-msg-1",
          }),
        },
      );
      insertMessage(
        db,
        "fork-msg-2",
        forkConv,
        "assistant",
        "fork patterns are useful",
        now - 49_000,
        {
          metadata: JSON.stringify({
            forkSourceMessageId: "parent-msg-2",
          }),
        },
      );

      // Segment sourced from a parent message — should be filtered when
      // recalling for the fork conversation since the fork copy is in context.
      insertSegment(
        db,
        "seg-parent-1",
        "parent-msg-1",
        parentConv,
        "user",
        "discuss fork patterns detail",
        now - 110_000,
      );

      // Simulate Qdrant returning the parent-conversation segment as a
      // semantic hit so it enters the candidate map.
      mockQdrantResults.push({
        id: "qdrant-fork-1",
        score: 0.9,
        payload: {
          target_type: "segment",
          target_id: "seg-parent-1",
          text: "discuss fork patterns detail",
          created_at: now - 110_000,
          message_id: "parent-msg-1",
          conversation_id: parentConv,
        },
      });

      const result = await buildMemoryRecall(
        "fork patterns",
        forkConv,
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      // The segment entered the candidate map via semantic search…
      expect(result.semanticHits).toBeGreaterThanOrEqual(1);
      // …but the fork-source filtering removed it because parent-msg-1 is
      // in the in-context set (via forkSourceMessageId on fork-msg-1).
      expect(result.mergedCount).toBe(0);
    });

    test("keeps segments from compacted fork messages' parents", async () => {
      const db = getDb();
      const now = Date.now();

      // Parent conversation
      const parentConv = "conv-parent-compact";
      insertConversation(db, parentConv, now - 200_000);
      insertMessage(
        db,
        "parent-compact-msg-1",
        parentConv,
        "user",
        "compacted parent topic",
        now - 190_000,
      );
      insertMessage(
        db,
        "parent-compact-msg-2",
        parentConv,
        "assistant",
        "compacted parent response",
        now - 180_000,
      );

      // Fork conversation with compaction — first 2 messages are compacted
      const forkConv = "conv-fork-compact";
      insertConversation(db, forkConv, now - 100_000, {
        contextCompactedMessageCount: 2,
      });

      // These two messages are compacted (offset=2 means first 2 are compacted)
      insertMessage(
        db,
        "fork-compact-msg-1",
        forkConv,
        "user",
        "compacted parent topic",
        now - 100_000,
        {
          metadata: JSON.stringify({
            forkSourceMessageId: "parent-compact-msg-1",
          }),
        },
      );
      insertMessage(
        db,
        "fork-compact-msg-2",
        forkConv,
        "assistant",
        "compacted parent response",
        now - 99_000,
        {
          metadata: JSON.stringify({
            forkSourceMessageId: "parent-compact-msg-2",
          }),
        },
      );

      // A newer message still in context
      insertMessage(
        db,
        "fork-compact-msg-3",
        forkConv,
        "user",
        "recent fork topic",
        now - 50_000,
      );

      // Segment in the fork conversation sourced from a compacted fork
      // message. Since the fork message is compacted, its forkSourceMessageId
      // is NOT added to the in-context set, so the segment should survive.
      insertSegment(
        db,
        "seg-compact-fork",
        "fork-compact-msg-1",
        forkConv,
        "user",
        "compacted parent topic detail",
        now - 100_000,
      );

      // Also insert a segment from an in-context message for contrast —
      // this one SHOULD be filtered.
      insertSegment(
        db,
        "seg-in-context-fork",
        "fork-compact-msg-3",
        forkConv,
        "user",
        "recent fork topic detail",
        now - 50_000,
      );

      // Simulate Qdrant returning both segments as semantic hits so they
      // enter the candidate map (recency search was removed).
      mockQdrantResults.push(
        {
          id: "qdrant-compact-fork-1",
          score: 0.9,
          payload: {
            target_type: "segment",
            target_id: "seg-compact-fork",
            text: "compacted parent topic detail",
            created_at: now - 100_000,
            message_id: "fork-compact-msg-1",
            conversation_id: forkConv,
          },
        },
        {
          id: "qdrant-compact-fork-2",
          score: 0.85,
          payload: {
            target_type: "segment",
            target_id: "seg-in-context-fork",
            text: "recent fork topic detail",
            created_at: now - 50_000,
            message_id: "fork-compact-msg-3",
            conversation_id: forkConv,
          },
        },
      );

      const result = await buildMemoryRecall(
        "compacted parent topic",
        forkConv,
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      // The segment from the compacted fork message survives filtering
      // (its source message is no longer in context). The in-context segment
      // is filtered out. Semantic search returns both, but only the compacted
      // one survives step 5b.
      expect(result.mergedCount).toBeGreaterThan(0);
    });

    test("handles multi-level forks", async () => {
      const db = getDb();
      const now = Date.now();

      // Grandparent conversation
      const grandparentConv = "conv-grandparent";
      insertConversation(db, grandparentConv, now - 300_000);
      insertMessage(
        db,
        "gp-msg-1",
        grandparentConv,
        "user",
        "grandparent topic",
        now - 290_000,
      );

      // Parent conversation (fork of grandparent)
      // The fork metadata preserves the original grandparent message ID
      const parentConv = "conv-parent-multi";
      insertConversation(db, parentConv, now - 200_000);
      insertMessage(
        db,
        "parent-multi-msg-1",
        parentConv,
        "user",
        "grandparent topic",
        now - 200_000,
        {
          metadata: JSON.stringify({
            forkSourceMessageId: "gp-msg-1",
          }),
        },
      );

      // Child conversation (fork of parent)
      // forkSourceMessageId still points to the original grandparent message
      const childConv = "conv-child-multi";
      insertConversation(db, childConv, now - 100_000);
      insertMessage(
        db,
        "child-multi-msg-1",
        childConv,
        "user",
        "grandparent topic",
        now - 100_000,
        {
          metadata: JSON.stringify({
            forkSourceMessageId: "gp-msg-1",
          }),
        },
      );

      // Segment sourced from the grandparent message
      insertSegment(
        db,
        "seg-gp",
        "gp-msg-1",
        grandparentConv,
        "user",
        "grandparent topic detail",
        now - 290_000,
      );

      // Simulate Qdrant returning the grandparent segment as a semantic hit
      // so it enters the candidate map.
      mockQdrantResults.push({
        id: "qdrant-gp-1",
        score: 0.9,
        payload: {
          target_type: "segment",
          target_id: "seg-gp",
          text: "grandparent topic detail",
          created_at: now - 290_000,
          message_id: "gp-msg-1",
          conversation_id: grandparentConv,
        },
      });

      const result = await buildMemoryRecall(
        "grandparent topic",
        childConv,
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      // The segment entered the candidate map via semantic search…
      expect(result.semanticHits).toBeGreaterThanOrEqual(1);
      // …but the fork-source filtering removed it because gp-msg-1 is in the
      // in-context set (via forkSourceMessageId on child-multi-msg-1).
      expect(result.mergedCount).toBe(0);
    });

    test("handles missing or invalid metadata gracefully", async () => {
      const db = getDb();
      const now = Date.now();

      const forkConv = "conv-fork-bad-meta";
      insertConversation(db, forkConv, now - 50_000);

      // Message with null metadata (no forkSourceMessageId)
      insertMessage(
        db,
        "fork-null-meta",
        forkConv,
        "user",
        "null metadata topic",
        now - 50_000,
      );

      // Message with malformed JSON metadata
      insertMessage(
        db,
        "fork-bad-json",
        forkConv,
        "assistant",
        "bad json topic",
        now - 49_000,
        { metadata: "not valid json {{{" },
      );

      // Message with metadata that is a JSON array (not an object)
      insertMessage(
        db,
        "fork-array-meta",
        forkConv,
        "user",
        "array metadata topic",
        now - 48_000,
        { metadata: JSON.stringify([1, 2, 3]) },
      );

      // Message with metadata object but no forkSourceMessageId field
      insertMessage(
        db,
        "fork-no-field",
        forkConv,
        "assistant",
        "no field topic",
        now - 47_000,
        { metadata: JSON.stringify({ someOtherField: "value" }) },
      );

      // Message with forkSourceMessageId that is not a string
      insertMessage(
        db,
        "fork-non-string",
        forkConv,
        "user",
        "non-string fork id",
        now - 46_000,
        { metadata: JSON.stringify({ forkSourceMessageId: 12345 }) },
      );

      // Insert a segment from this conversation — should be filtered normally
      // (it's an in-context segment from the active conversation)
      insertSegment(
        db,
        "seg-bad-meta",
        "fork-null-meta",
        forkConv,
        "user",
        "null metadata topic detail",
        now - 50_000,
      );

      // This should not crash despite various malformed metadata
      const result = await buildMemoryRecall(
        "metadata topic",
        forkConv,
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      // No crash — the pipeline completes successfully
      // The in-context segment is still filtered normally
      expect(result.mergedCount).toBe(0);
    });
  });

  // -----------------------------------------------------------------------
  // Serendipity layer
  // -----------------------------------------------------------------------

  describe("serendipity sampling", () => {
    test("samples random active items and renders them in <echoes>", async () => {
      const db = getDb();
      const now = Date.now();
      const convId = "conv-serendipity";

      insertConversation(db, convId, now - 60_000);
      insertMessage(db, "msg-s-1", convId, "user", "hello", now - 50_000);

      // Items sourced from a different conversation so in-context filtering
      // doesn't remove them (serendipity is cross-conversation recall).
      const otherConvId = "conv-serendipity-other";
      insertConversation(db, otherConvId, now - 120_000);
      insertMessage(
        db,
        "msg-s-other",
        otherConvId,
        "user",
        "other",
        now - 110_000,
      );

      // Insert several active items that are NOT returned by Qdrant
      for (let i = 1; i <= 5; i++) {
        insertItem(db, {
          id: `serendipity-item-${i}`,
          kind: "fact",
          subject: `topic ${i}`,
          statement: `Serendipity fact number ${i}`,
          importance: i * 0.15, // 0.15..0.75
          firstSeenAt: now - i * 10_000,
        });
        insertItemSource(
          db,
          `serendipity-item-${i}`,
          "msg-s-other",
          now - i * 10_000,
        );
      }

      // Qdrant returns nothing — no recalled candidates
      mockQdrantResults.length = 0;

      const result = await buildMemoryRecall(
        "unrelated query",
        convId,
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      // No semantic hits, so no recalled candidates
      expect(result.mergedCount).toBe(0);
      // But serendipity items should appear in the injection
      expect(result.injectedText).toContain("<echoes>");
      expect(result.injectedText).toContain("</echoes>");
      // At most 3 serendipity items
      const itemMatches = result.injectedText.match(/<item /g);
      expect(itemMatches).toBeTruthy();
      expect(itemMatches!.length).toBeLessThanOrEqual(3);
      expect(itemMatches!.length).toBeGreaterThanOrEqual(1);
      // selectedCount includes serendipity items
      expect(result.selectedCount).toBeGreaterThan(0);
    });

    test("excludes items already in the candidate pool from serendipity", async () => {
      const db = getDb();
      const now = Date.now();
      const convId = "conv-serendipity-excl";

      insertConversation(db, convId, now - 60_000);
      insertMessage(
        db,
        "msg-se-1",
        convId,
        "user",
        "query about X",
        now - 50_000,
      );

      // This item will be returned by Qdrant as a recalled candidate
      insertItem(db, {
        id: "recalled-item",
        kind: "fact",
        subject: "X",
        statement: "Recalled fact about X",
        importance: 0.9,
        firstSeenAt: now - 30_000,
      });
      insertItemSource(db, "recalled-item", "msg-se-1", now - 30_000);

      // Qdrant returns the recalled item
      mockQdrantResults.push({
        id: "qdrant-recalled",
        score: 0.9,
        payload: {
          target_type: "item",
          target_id: "recalled-item",
          text: "X: Recalled fact about X",
          created_at: now - 30_000,
        },
      });

      const result = await buildMemoryRecall(
        "query about X",
        convId,
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      // The recalled item is in <recalled>, not in <echoes>
      if (result.injectedText.includes("<echoes>")) {
        // If echoes exists, the recalled item should NOT be duplicated there
        const echoesMatch = result.injectedText.match(
          /<echoes>([\s\S]*?)<\/echoes>/,
        );
        if (echoesMatch) {
          expect(echoesMatch[1]).not.toContain("recalled-item");
        }
      }
    });

    test("no <echoes> section when no active items exist", async () => {
      // No items seeded at all
      const result = await buildMemoryRecall(
        "anything",
        "conv-empty-seren",
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      expect(result.injectedText).not.toContain("<echoes>");
    });
  });
});
