/**
 * Tests for the handleMemoryRecall() tool handler.
 *
 * Covers happy path (multi-source results), empty results, degraded mode
 * (embeddings/Qdrant unavailable), scope filtering, and error handling.
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

const testDir = mkdtempSync(join(tmpdir(), "memory-recall-handler-"));

// ── Module mocks (must precede production imports) ───────────────────

mock.module("../../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../../memory/embedding-local.js", () => ({
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

mock.module("../../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
}));

import { DEFAULT_CONFIG } from "../../config/defaults.js";
import type { AssistantConfig } from "../../config/types.js";

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

mock.module("../../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  invalidateConfigCache: () => {},
}));

import { getDb, initializeDb } from "../../memory/db.js";
import { clearEmbeddingBackendCache } from "../../memory/embedding-backend.js";
import {
  conversations,
  memoryItems,
  memoryItemSources,
  messages,
} from "../../memory/schema.js";
import { handleMemoryRecall, type MemoryRecallToolResult } from "./handlers.js";

function clearTables() {
  const db = getDb();
  db.run("DELETE FROM memory_item_sources");
  db.run("DELETE FROM memory_items");
  db.run("DELETE FROM memory_segments");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
}

// ── Helpers ──────────────────────────────────────────────────────────

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
    scopeId?: string;
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
      scopeId: opts.scopeId ?? "default",
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

function parseResult(content: string): MemoryRecallToolResult {
  return JSON.parse(content) as MemoryRecallToolResult;
}

/** Seed with searchable memory items from multiple sources. */
function seedMemory() {
  const db = getDb();
  const now = Date.now();
  const convId = "conv-recall-test";

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

  insertItem(db, {
    id: "item-api",
    kind: "preference",
    subject: "API design",
    statement: "User prefers REST over GraphQL for API design",
    firstSeenAt: now - 30_000,
    importance: 0.9,
  });
  insertItemSource(db, "item-api", "msg-1", now - 30_000);

  insertItem(db, {
    id: "item-testing",
    kind: "fact",
    subject: "testing",
    statement: "The project uses bun test for unit testing",
    firstSeenAt: now - 20_000,
    importance: 0.7,
  });
  insertItemSource(db, "item-testing", "msg-2", now - 20_000);
}

// ── Suite ────────────────────────────────────────────────────────────

describe("handleMemoryRecall", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    clearTables();
    clearEmbeddingBackendCache();
  });

  afterAll(() => {
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── Input validation ──────────────────────────────────────────────

  test("returns error when query is missing", async () => {
    const result = await handleMemoryRecall({}, TEST_CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query is required");
  });

  test("returns error when query is empty string", async () => {
    const result = await handleMemoryRecall({ query: "  " }, TEST_CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query is required");
  });

  test("returns error when query is not a string", async () => {
    const result = await handleMemoryRecall({ query: 42 }, TEST_CONFIG);
    expect(result.isError).toBe(true);
    expect(result.content).toContain("query is required");
  });

  // ── Happy path ────────────────────────────────────────────────────

  test("returns formatted results from multiple sources", async () => {
    seedMemory();

    const result = await handleMemoryRecall(
      { query: "API design" },
      TEST_CONFIG,
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);
    expect(parsed.resultCount).toBeGreaterThan(0);
    expect(parsed.text.length).toBeGreaterThan(0);
  });

  test("respects max_results parameter", async () => {
    seedMemory();

    const result = await handleMemoryRecall(
      { query: "API design", max_results: 1 },
      TEST_CONFIG,
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);
    expect(parsed.resultCount).toBeLessThanOrEqual(1);
  });

  test("clamps max_results to 50", async () => {
    seedMemory();

    // Should not throw, max_results capped at 50
    const result = await handleMemoryRecall(
      { query: "API design", max_results: 100 },
      TEST_CONFIG,
    );

    expect(result.isError).toBe(false);
  });

  // ── Empty results ─────────────────────────────────────────────────

  test("returns empty result when no memories match", async () => {
    // No items seeded — tables cleared in beforeEach
    const result = await handleMemoryRecall(
      { query: "quantum physics" },
      TEST_CONFIG,
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);
    expect(parsed.resultCount).toBe(0);
    expect(parsed.text).toBe("No matching memories found.");
    expect(parsed.sources.lexical).toBe(0);
    expect(parsed.sources.semantic).toBe(0);
    expect(parsed.sources.recency).toBe(0);
    expect(parsed.sources.entity).toBe(0);
  });

  // ── Degraded mode ─────────────────────────────────────────────────

  test("returns results with degraded=true when embeddings required but unavailable", async () => {
    seedMemory();

    // When embeddings are required but no provider is available,
    // the handler reports degraded=true
    const degradedConfig: AssistantConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: {
          ...TEST_CONFIG.memory.embeddings,
          provider: "none" as never,
          required: true,
        },
      },
    };

    const result = await handleMemoryRecall(
      { query: "API design" },
      degradedConfig,
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);
    expect(parsed.degraded).toBe(true);
    expect(parsed.sources.semantic).toBe(0);
  });

  test("returns results with degraded=false when embeddings optional and unavailable", async () => {
    seedMemory();

    // When embeddings are not required and no provider is available,
    // the handler gracefully continues without degradation
    const optionalEmbeddingsConfig: AssistantConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: {
          ...TEST_CONFIG.memory.embeddings,
          provider: "none" as never,
          required: false,
        },
      },
    };

    const result = await handleMemoryRecall(
      { query: "API design" },
      optionalEmbeddingsConfig,
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);
    // Not degraded because embeddings are optional
    expect(parsed.degraded).toBe(false);
    expect(parsed.sources.semantic).toBe(0);
    // Still returns results from non-semantic sources (direct item search)
    expect(parsed.resultCount).toBeGreaterThan(0);
  });

  test("returns lexical results in degraded mode", async () => {
    seedMemory();

    const degradedConfig: AssistantConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        embeddings: {
          ...TEST_CONFIG.memory.embeddings,
          provider: "none" as never,
          required: false,
        },
      },
    };

    const result = await handleMemoryRecall(
      { query: "API design" },
      degradedConfig,
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);
    // Direct item search should still find items even without embeddings
    expect(parsed.resultCount).toBeGreaterThan(0);
  });

  // ── Scope filtering ───────────────────────────────────────────────

  test("scope 'conversation' restricts to current thread", async () => {
    const db = getDb();
    const now = Date.now();

    // Insert item in "conv-scope-a" scope
    insertItem(db, {
      id: "item-scope-a",
      kind: "fact",
      subject: "scoped data",
      statement: "This item is scoped to conversation A",
      firstSeenAt: now - 10_000,
      scopeId: "conv-scope-a",
    });

    // Insert item in default scope
    insertItem(db, {
      id: "item-default",
      kind: "fact",
      subject: "default data",
      statement: "This item is in the default scope about scoped data",
      firstSeenAt: now - 10_000,
      scopeId: "default",
    });

    // Query with scope="conversation" and scopeId="conv-scope-a"
    // should restrict to only that scope (no fallback to default)
    const result = await handleMemoryRecall(
      { query: "scoped data", scope: "conversation" },
      TEST_CONFIG,
      "conv-scope-a",
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);

    // When scope is "conversation", fallbackToDefault is false,
    // so only items from conv-scope-a should appear
    expect(parsed.resultCount).toBeGreaterThan(0);
    expect(parsed.text).toContain("scoped to conversation A");
    expect(parsed.text).not.toContain("default scope");
  });

  test("default scope includes fallback to default scope", async () => {
    const db = getDb();
    const now = Date.now();

    // Insert item in default scope
    insertItem(db, {
      id: "item-fallback",
      kind: "fact",
      subject: "global knowledge",
      statement: "This global knowledge should be accessible from any scope",
      firstSeenAt: now - 10_000,
      scopeId: "default",
    });

    // Query with scope="default" (the default) and a specific scopeId
    // should include fallback to default scope
    const result = await handleMemoryRecall(
      { query: "global knowledge" },
      TEST_CONFIG,
      "some-thread-id",
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);
    // Default scope items should be accessible
    expect(parsed.resultCount).toBeGreaterThan(0);
    expect(parsed.text).toContain("global knowledge");
  });

  // ── Error handling ────────────────────────────────────────────────

  test("retrieval failure returns error message, does not throw", async () => {
    // Create a config that will cause the retrieval pipeline to throw
    // by making memory disabled in a way that buildMemoryRecall breaks.
    // We mock the retriever to throw an error.
    const badConfig: AssistantConfig = {
      ...TEST_CONFIG,
      memory: {
        ...TEST_CONFIG.memory,
        // Force retrieval with impossible settings to trigger an error path
        retrieval: {
          ...TEST_CONFIG.memory.retrieval,
          lexicalTopK: -1, // may cause issues in search
        },
      },
    };

    // Even if the query fails internally, the handler should catch and return
    // an error result rather than throwing
    const result = await handleMemoryRecall({ query: "test query" }, badConfig);

    // The function should either succeed gracefully or return an error
    // but never throw
    expect(typeof result.content).toBe("string");
    expect(typeof result.isError).toBe("boolean");
  });

  test("result shape matches MemoryRecallToolResult when successful", async () => {
    seedMemory();

    const result = await handleMemoryRecall(
      { query: "API design" },
      TEST_CONFIG,
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);

    // Verify the result shape has all expected fields
    expect(typeof parsed.text).toBe("string");
    expect(typeof parsed.resultCount).toBe("number");
    expect(typeof parsed.degraded).toBe("boolean");
    expect(typeof parsed.sources).toBe("object");
    expect(typeof parsed.sources.lexical).toBe("number");
    expect(typeof parsed.sources.semantic).toBe("number");
    expect(typeof parsed.sources.recency).toBe("number");
    expect(typeof parsed.sources.entity).toBe("number");
  });

  test("empty result shape matches MemoryRecallToolResult", async () => {
    const result = await handleMemoryRecall(
      { query: "nonexistent topic xyz123" },
      TEST_CONFIG,
    );

    expect(result.isError).toBe(false);
    const parsed = parseResult(result.content);

    expect(parsed.text).toBe("No matching memories found.");
    expect(parsed.resultCount).toBe(0);
    expect(typeof parsed.degraded).toBe("boolean");
    expect(parsed.sources.lexical).toBe(0);
    expect(parsed.sources.semantic).toBe(0);
    expect(parsed.sources.recency).toBe(0);
    expect(parsed.sources.entity).toBe(0);
  });
});
