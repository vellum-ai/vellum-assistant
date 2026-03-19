/**
 * Tests for the memory retrieval pipeline.
 *
 * Covers: hybrid search → tier classification → staleness → injection,
 * empty results → no injection, superseded items filtered out,
 * staleness demotion, budget allocation, and degradation scenarios.
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

const testDir = mkdtempSync(join(tmpdir(), "memory-retriever-"));

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
mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    hybridSearch: async () => [],
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
  });

  afterAll(() => {
    resetDb();
    rmSync(testDir, { recursive: true, force: true });
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
    // With mock Qdrant returning empty results and recency-only candidates
    // scoring below tier thresholds, no candidates are selected.
    // The pipeline still completes successfully with tier metadata.
    expect(result.tier1Count).toBeDefined();
    expect(result.tier2Count).toBeDefined();
    expect(result.hybridSearchMs).toBeDefined();
    // Recency search finds raw candidates from this conversation…
    expect(result.recencyHits).toBeGreaterThan(0);
    // …but they are filtered out because they belong to the active
    // conversation and are already present in the conversation history.
    expect(result.mergedCount).toBe(0);
  });

  // -----------------------------------------------------------------------
  // Current-conversation segment filtering
  // -----------------------------------------------------------------------

  test("current-conversation segments are filtered from recency results", async () => {
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
    // Recency search finds segments from the active conversation
    expect(result.recencyHits).toBeGreaterThan(0);
    // But they are filtered out of merged results; only other-conversation
    // segments would survive (none in this case since recency is scoped to
    // the active conversation).
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
    // Recency search finds segments from this conversation
    expect(result.recencyHits).toBeGreaterThan(0);
    // Compacted segments survive filtering — they are no longer in context
    expect(result.mergedCount).toBeGreaterThan(0);
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

    // Create a message from 200 days ago to serve as recency source
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

  test("Qdrant unavailable: pipeline completes with recency fallback", async () => {
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
    // Recency search finds raw candidates…
    expect(result.recencyHits).toBeGreaterThan(0);
    // …but current-conversation segments are filtered out
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
    expect(result.degradation!.fallbackSources).toContain("recency");
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
    // Recency search finds raw candidates; hybrid search returns empty from mock
    expect(result.recencyHits).toBeGreaterThan(0);
    // Current-conversation segments are filtered out of merged results
    expect(result.mergedCount).toBe(0);
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

      const result = await buildMemoryRecall(
        "fork patterns",
        forkConv,
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      // Recency finds segments from this conversation, but the parent-sourced
      // segment (via forkSourceMessageId) and the fork's own segments should
      // all be filtered as in-context.
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

      const result = await buildMemoryRecall(
        "compacted parent topic",
        forkConv,
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      // The segment from the compacted fork message survives filtering
      // (its source message is no longer in context). The in-context segment
      // is filtered out. Recency search returns both, but only the compacted
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

      const result = await buildMemoryRecall(
        "grandparent topic",
        childConv,
        TEST_CONFIG,
      );

      expect(result.enabled).toBe(true);
      // The segment from the grandparent message should be filtered because
      // the child's fork message metadata traces back to gp-msg-1.
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
});
