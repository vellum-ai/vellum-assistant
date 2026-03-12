/**
 * Tests for graceful embedding degradation in the memory retrieval pipeline.
 *
 * Verifies that when semantic search subsystems (Qdrant, embedding provider)
 * are unavailable, the retriever falls back to lexical/recency/direct sources
 * with boosted limits, applies query expansion, and reports structured
 * degradation status in result metadata.
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

const testDir = mkdtempSync(join(tmpdir(), "memory-retriever-degrade-"));

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
import { buildMemoryRecall } from "../memory/retriever.js";
import {
  conversations,
  memoryItems,
  memoryItemSources,
  messages,
} from "../memory/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertConversation(
  db: ReturnType<typeof getDb>,
  id: string,
  createdAt: number,
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
      contextCompactedMessageCount: 0,
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
) {
  db.insert(messages)
    .values({
      id,
      conversationId,
      role,
      content: JSON.stringify([{ type: "text", text }]),
      createdAt,
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
  const convId = "conv-degrade-test";

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

describe("Memory Retriever Degradation", () => {
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
  // Non-degraded baseline
  // -----------------------------------------------------------------------

  test("non-degraded baseline: returns results with degraded=false when all systems available", async () => {
    seedMemory();

    const result = await buildMemoryRecall(
      "API design",
      "conv-degrade-test",
      TEST_CONFIG,
    );

    expect(result.enabled).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.degradation).toBeUndefined();
    // Lexical search should find matches
    expect(result.lexicalHits).toBeGreaterThan(0);
    // Should have selected some candidates
    expect(result.selectedCount).toBeGreaterThan(0);
    expect(result.injectedText.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Qdrant circuit breaker open
  // -----------------------------------------------------------------------

  test("Qdrant unavailable: skips semantic search and boosts lexical limits", async () => {
    seedMemory();

    // Force the Qdrant circuit breaker open by importing and manipulating it.
    // We need to trip it by recording enough failures.
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
      "conv-degrade-test",
      TEST_CONFIG,
    );

    expect(result.enabled).toBe(true);
    // Semantic search should be skipped entirely
    expect(result.semanticHits).toBe(0);
    // Lexical search should still work (boosted limits)
    expect(result.lexicalHits).toBeGreaterThan(0);
    // Results should still be returned despite no semantic
    expect(result.selectedCount).toBeGreaterThan(0);
    expect(result.injectedText.length).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Embedding provider down
  // -----------------------------------------------------------------------

  test("embedding provider down: falls back to lexical-only when embeddings not required", async () => {
    seedMemory();

    // Config with no embedding provider available (no API keys, auto mode)
    const noEmbedConfig: AssistantConfig = {
      ...TEST_CONFIG,
      apiKeys: {
        ...TEST_CONFIG.apiKeys,
        openai: "",
        gemini: "",
        ollama: "",
      },
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: {
          ...TEST_CONFIG.memory.embeddings,
          provider: "openai",
          required: false,
        },
      },
    };

    const result = await buildMemoryRecall(
      "API design",
      "conv-degrade-test",
      noEmbedConfig,
    );

    expect(result.enabled).toBe(true);
    // With no embedding provider, semantic search should be skipped
    expect(result.semanticHits).toBe(0);
    // Lexical search should still produce results
    expect(result.lexicalHits).toBeGreaterThan(0);
    expect(result.selectedCount).toBeGreaterThan(0);
  });

  test("embedding provider down: returns degraded with structured status when embeddings required", async () => {
    seedMemory();

    const requiredEmbedConfig: AssistantConfig = {
      ...TEST_CONFIG,
      apiKeys: {
        ...TEST_CONFIG.apiKeys,
        openai: "",
        gemini: "",
        ollama: "",
      },
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
      "conv-degrade-test",
      requiredEmbedConfig,
    );

    expect(result.enabled).toBe(true);
    expect(result.degraded).toBe(true);
    // Structured degradation status should be present
    expect(result.degradation).toBeDefined();
    expect(result.degradation!.semanticUnavailable).toBe(true);
    expect(result.degradation!.reason).toBe("embedding_provider_down");
    expect(result.degradation!.fallbackSources).toContain("lexical");
    expect(result.degradation!.fallbackSources).toContain("recency");
    expect(result.degradation!.fallbackSources).toContain("direct_item");
  });

  // -----------------------------------------------------------------------
  // Query expansion in degraded mode
  // -----------------------------------------------------------------------

  test("query expansion: conversational query gets expanded to keywords when semantic unavailable", async () => {
    seedMemory();

    // Force degraded mode via circuit breaker
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

    // Use a conversational query full of stop words — query expansion should
    // strip them to meaningful keywords for better FTS recall.
    const result = await buildMemoryRecall(
      "what did we discuss about the API design?",
      "conv-degrade-test",
      TEST_CONFIG,
    );

    expect(result.enabled).toBe(true);
    expect(result.semanticHits).toBe(0);
    // The expanded query ("discuss", "API", "design") should match our seeded
    // segments and items containing those terms.
    expect(result.lexicalHits).toBeGreaterThan(0);
    expect(result.selectedCount).toBeGreaterThan(0);
    // Verify the injected text contains content from our seeded data
    expect(result.injectedText).toContain("API");
  });

  // -----------------------------------------------------------------------
  // Degradation status structure
  // -----------------------------------------------------------------------

  test("degradation status: includes expected fields for qdrant_unavailable", async () => {
    seedMemory();

    // Trip the circuit breaker
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

    // Disable early termination so the pipeline always reaches the
    // semantic search phase, where the open breaker triggers degradation.
    const configNoET: AssistantConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        retrieval: {
          ...TEST_CONFIG.memory.retrieval,
          earlyTermination: {
            ...TEST_CONFIG.memory.retrieval.earlyTermination,
            enabled: false,
          },
        },
      },
    };

    const result = await buildMemoryRecall(
      "API design",
      "conv-degrade-test",
      configNoET,
    );

    // The local stub produces a non-null zero vector, so semanticSearch()
    // is still attempted. The open breaker causes withQdrantBreaker() to
    // throw, which sets semanticSearchFailed = true and propagates into
    // the degradation field with reason 'qdrant_unavailable'.
    expect(result.enabled).toBe(true);
    expect(result.semanticHits).toBe(0);
    // Results are still returned from lexical sources
    expect(result.selectedCount).toBeGreaterThan(0);
    // Verify structured degradation metadata
    expect(result.degradation).toBeDefined();
    expect(result.degradation!.reason).toBe("qdrant_unavailable");
    expect(result.degradation!.semanticUnavailable).toBe(true);
    expect(result.degradation!.fallbackSources).toBeInstanceOf(Array);
    expect(result.degradation!.fallbackSources.length).toBeGreaterThan(0);
  });

  test("degradation status: entity fallback included when entity search enabled", async () => {
    seedMemory();

    const entityConfig: AssistantConfig = {
      ...TEST_CONFIG,
      apiKeys: {
        ...TEST_CONFIG.apiKeys,
        openai: "",
        gemini: "",
        ollama: "",
      },
      memory: {
        ...TEST_CONFIG.memory,
        entity: {
          ...TEST_CONFIG.memory.entity,
          enabled: true,
        },
        embeddings: {
          ...TEST_CONFIG.memory.embeddings,
          provider: "openai",
          required: true,
        },
      },
    };

    const result = await buildMemoryRecall(
      "API design",
      "conv-degrade-test",
      entityConfig,
    );

    expect(result.degradation).toBeDefined();
    expect(result.degradation!.fallbackSources).toContain("entity");
  });

  test("degradation status: entity fallback excluded when entity search disabled", async () => {
    seedMemory();

    const noEntityConfig: AssistantConfig = {
      ...TEST_CONFIG,
      apiKeys: {
        ...TEST_CONFIG.apiKeys,
        openai: "",
        gemini: "",
        ollama: "",
      },
      memory: {
        ...TEST_CONFIG.memory,
        entity: {
          ...TEST_CONFIG.memory.entity,
          enabled: false,
        },
        embeddings: {
          ...TEST_CONFIG.memory.embeddings,
          provider: "openai",
          required: true,
        },
      },
    };

    const result = await buildMemoryRecall(
      "API design",
      "conv-degrade-test",
      noEntityConfig,
    );

    expect(result.degradation).toBeDefined();
    expect(result.degradation!.fallbackSources).not.toContain("entity");
    expect(result.degradation!.fallbackSources).toContain("lexical");
    expect(result.degradation!.fallbackSources).toContain("recency");
    expect(result.degradation!.fallbackSources).toContain("direct_item");
  });

  // -----------------------------------------------------------------------
  // Local embedding stub end-to-end
  // -----------------------------------------------------------------------

  test("local embedding stub: pipeline completes non-degraded with zero-vector embeddings", async () => {
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
      "conv-degrade-test",
      localEmbedConfig,
    );

    // The local stub returns zero vectors — embedding "succeeds" so the
    // pipeline proceeds non-degraded end-to-end.
    expect(result.enabled).toBe(true);
    expect(result.degraded).toBe(false);
    expect(result.selectedCount).toBeGreaterThan(0);
  });

  // -----------------------------------------------------------------------
  // Degraded results bypass the recall cache
  // -----------------------------------------------------------------------

  test("degraded results are not cached", async () => {
    seedMemory();

    // Trip the circuit breaker so semantic search fails
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

    // Disable early termination so semantic search is attempted and fails,
    // which sets semanticSearchFailed=true → result.degraded=true.
    const degradedConfig: AssistantConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        retrieval: {
          ...TEST_CONFIG.memory.retrieval,
          earlyTermination: {
            ...TEST_CONFIG.memory.retrieval.earlyTermination,
            enabled: false,
          },
        },
      },
    };

    const first = await buildMemoryRecall(
      "API design cache test",
      "conv-degrade-test",
      degradedConfig,
    );
    expect(first.degraded).toBe(true);
    expect(first.selectedCount).toBeGreaterThan(0);

    // Second call with same inputs — should NOT be served from cache.
    // If the degraded result were incorrectly cached, this call would
    // return instantly from cache. Instead it should re-execute the
    // pipeline and produce a fresh degraded result.
    const second = await buildMemoryRecall(
      "API design cache test",
      "conv-degrade-test",
      degradedConfig,
    );
    expect(second.degraded).toBe(true);
    expect(second.selectedCount).toBeGreaterThan(0);

    // Verify the cache is empty for this query by resetting the breaker
    // and calling again — a non-degraded result should come back (proving
    // the degraded result was never cached).
    _resetQdrantBreaker();
    const recovered = await buildMemoryRecall(
      "API design cache test",
      "conv-degrade-test",
      degradedConfig,
    );
    expect(recovered.degraded).toBe(false);
  });
});
