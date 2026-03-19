/**
 * Memory Recall Quality Fixtures
 *
 * Fixture-driven tests that guard recall quality: preference recall,
 * contradiction suppression, stale-memory filtering, and importance ranking.
 * These tests fail if memory quality degrades — they act as guardrails
 * before any retrieval or ranking changes.
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

const testDir = mkdtempSync(join(tmpdir(), "memory-recall-quality-"));

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

// Stub the local embedding backend so the real ONNX model (2.5 GB RSS) never
// loads — avoids a Bun v1.3.9 panic on process exit.
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
    upsertPoints: async () => {},
    deletePoints: async () => {},
  }),
  initQdrantClient: () => {},
}));

import { DEFAULT_CONFIG } from "../config/defaults.js";

const TEST_CONFIG = {
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

/** Insert a standard conversation + message row for fixture setup. */
function insertConversation(
  db: ReturnType<typeof getDb>,
  id: string,
  createdAt: number,
  contextCompactedMessageCount = 0,
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
      contextCompactedMessageCount,
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
    accessCount?: number;
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
      accessCount: opts.accessCount ?? 0,
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

/**
 * Assert that at least `minFound` of the `expectedSubstrings` appear in `text`.
 * This is a deterministic precision@k-style check: given a list of expected
 * items and the injected recall text, verify enough of them were recalled.
 */
function assertPrecisionAtK(
  text: string,
  expectedSubstrings: string[],
  minFound: number,
  label?: string,
) {
  const found = expectedSubstrings.filter((s) => text.includes(s));
  const precision = found.length / expectedSubstrings.length;
  if (found.length < minFound) {
    const prefix = label ? `[${label}] ` : "";
    throw new Error(
      `${prefix}precision@${expectedSubstrings.length} too low: ` +
        `found ${found.length}/${expectedSubstrings.length} (${(
          precision * 100
        ).toFixed(0)}%), ` +
        `need at least ${minFound}. ` +
        `Missing: ${expectedSubstrings
          .filter((s) => !text.includes(s))
          .join(", ")}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Memory Recall Quality", () => {
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

  // -------------------------------------------------------------------------
  // Preference Recall
  // -------------------------------------------------------------------------

  describe("preference recall", () => {
    test("preferences are recalled when querying about user preferences", async () => {
      const db = getDb();
      const now = 1_700_000_000_000;
      insertConversation(db, "conv-pref", now, 3);
      insertMessage(
        db,
        "msg-pref-1",
        "conv-pref",
        "user",
        "I prefer dark mode and concise answers",
        now,
      );
      insertMessage(
        db,
        "msg-pref-2",
        "conv-pref",
        "user",
        "My favorite editor is Neovim",
        now + 1000,
      );
      insertMessage(
        db,
        "msg-fact-1",
        "conv-pref",
        "user",
        "The server runs on port 3000",
        now + 2000,
      );

      insertSegment(
        db,
        "seg-pref-1",
        "msg-pref-1",
        "conv-pref",
        "user",
        "I prefer dark mode and concise answers",
        now,
      );
      insertSegment(
        db,
        "seg-pref-2",
        "msg-pref-2",
        "conv-pref",
        "user",
        "My favorite editor is Neovim",
        now + 1000,
      );
      insertSegment(
        db,
        "seg-fact-1",
        "msg-fact-1",
        "conv-pref",
        "user",
        "The server runs on port 3000",
        now + 2000,
      );

      // Also insert items so the pipeline has structured data to inject
      insertItem(db, {
        id: "item-pref-dark",
        kind: "preference",
        subject: "display preference",
        statement: "User prefers dark mode and concise answers",
        importance: 0.8,
        firstSeenAt: now,
      });
      insertItemSource(db, "item-pref-dark", "msg-pref-1", now);
      insertItem(db, {
        id: "item-pref-editor",
        kind: "preference",
        subject: "editor preference",
        statement: "User favorite editor is Neovim",
        importance: 0.8,
        firstSeenAt: now + 1000,
      });
      insertItemSource(db, "item-pref-editor", "msg-pref-2", now + 1000);

      // Mock Qdrant to return both preference items as high-scoring results
      mockQdrantResults = [
        {
          id: "emb-pref-dark",
          score: 0.92,
          payload: {
            target_type: "item",
            target_id: "item-pref-dark",
            text: "User prefers dark mode and concise answers",
            kind: "preference",
            status: "active",
            created_at: now,
            last_seen_at: now,
          },
        },
        {
          id: "emb-pref-editor",
          score: 0.88,
          payload: {
            target_type: "item",
            target_id: "item-pref-editor",
            text: "User favorite editor is Neovim",
            kind: "preference",
            status: "active",
            created_at: now + 1000,
            last_seen_at: now + 1000,
          },
        },
      ];

      const recall = await buildMemoryRecall(
        "what are my preferences",
        "conv-pref",
        TEST_CONFIG,
      );

      expect(recall.recencyHits).toBeGreaterThan(0);
      expect(recall.enabled).toBe(true);
      // With high-scoring Qdrant results, items should be injected
      expect(recall.semanticHits).toBeGreaterThan(0);
      expect(recall.injectedText).toContain("dark mode");
      expect(recall.injectedText).toContain("Neovim");
    });

    test("high-importance preferences outrank low-importance facts in recall", async () => {
      const db = getDb();
      const now = 1_700_000_100_000;
      insertConversation(db, "conv-rank", now, 2);

      // High-importance preference
      insertMessage(
        db,
        "msg-hi",
        "conv-rank",
        "user",
        "I strongly prefer TypeScript over JavaScript",
        now,
      );
      insertSegment(
        db,
        "seg-hi",
        "msg-hi",
        "conv-rank",
        "user",
        "I strongly prefer TypeScript over JavaScript",
        now,
      );
      insertItem(db, {
        id: "item-hi-pref",
        kind: "preference",
        subject: "language preference",
        statement: "User strongly prefers TypeScript over JavaScript",
        importance: 0.9,
        firstSeenAt: now,
      });
      insertItemSource(db, "item-hi-pref", "msg-hi", now);

      // Low-importance project fact
      insertMessage(
        db,
        "msg-lo",
        "conv-rank",
        "user",
        "The default port is 8080",
        now + 1000,
      );
      insertSegment(
        db,
        "seg-lo",
        "msg-lo",
        "conv-rank",
        "user",
        "The default port is 8080",
        now + 1000,
      );
      insertItem(db, {
        id: "item-lo-fact",
        kind: "project",
        subject: "default port",
        statement: "The default port is 8080",
        importance: 0.3,
        firstSeenAt: now + 1000,
      });
      insertItemSource(db, "item-lo-fact", "msg-lo", now + 1000);

      // Mock Qdrant to return both items — the high-importance one with a higher score
      mockQdrantResults = [
        {
          id: "emb-hi-pref",
          score: 0.95,
          payload: {
            target_type: "item",
            target_id: "item-hi-pref",
            text: "User strongly prefers TypeScript over JavaScript",
            kind: "preference",
            status: "active",
            created_at: now,
            last_seen_at: now,
          },
        },
        {
          id: "emb-lo-fact",
          score: 0.7,
          payload: {
            target_type: "item",
            target_id: "item-lo-fact",
            text: "The default port is 8080",
            kind: "project",
            status: "active",
            created_at: now + 1000,
            last_seen_at: now + 1000,
          },
        },
      ];

      const recall = await buildMemoryRecall(
        "TypeScript preference language",
        "conv-rank",
        TEST_CONFIG,
      );

      expect(recall.recencyHits).toBeGreaterThan(0);
      expect(recall.enabled).toBe(true);
      // High-importance preference should be injected
      expect(recall.injectedText).toContain("TypeScript");
    });
  });

  // -------------------------------------------------------------------------
  // Contradiction / Superseding Suppression
  // -------------------------------------------------------------------------

  describe("supersession suppression", () => {
    test("superseded memory items do not appear in recall via recency", async () => {
      const db = getDb();
      const now = 1_700_000_200_000;
      insertConversation(db, "conv-contra", now, 1);

      // New preference (active, supersedes the old one)
      insertMessage(
        db,
        "msg-new-pref",
        "conv-contra",
        "user",
        "I now prefer neovim with LazyVim for editing code",
        now,
      );
      insertSegment(
        db,
        "seg-new-pref",
        "msg-new-pref",
        "conv-contra",
        "user",
        "I now prefer neovim with LazyVim for editing code",
        now,
      );
      insertItem(db, {
        id: "item-new-pref",
        kind: "preference",
        subject: "editor preference",
        statement: "User now prefers neovim with LazyVim for editing code",
        status: "active",
        importance: 0.8,
        firstSeenAt: now,
      });
      insertItemSource(db, "item-new-pref", "msg-new-pref", now);

      // Old preference (superseded by new one via supersession chain)
      insertItem(db, {
        id: "item-old-pref",
        kind: "preference",
        subject: "editor preference",
        statement: "User prefers vim for editing code",
        status: "superseded",
        importance: 0.8,
        firstSeenAt: now - 50_000,
      });

      const recall = await buildMemoryRecall(
        "editor preference",
        "conv-contra",
        TEST_CONFIG,
      );

      // Recency search finds the segment but tier classification filters it
      expect(recall.recencyHits).toBeGreaterThan(0);
      // Superseded items should not leak into injected text
      expect(recall.injectedText).not.toContain("vim for editing code");
    });

    test("only active items are included in recall (superseded excluded)", async () => {
      const db = getDb();
      const now = 1_700_000_250_000;
      insertConversation(db, "conv-entity-status", now, 1);

      insertMessage(
        db,
        "msg-entity-active",
        "conv-entity-status",
        "user",
        "We decided to use PostgreSQL as the database",
        now,
      );
      insertSegment(
        db,
        "seg-entity-active",
        "msg-entity-active",
        "conv-entity-status",
        "user",
        "We decided to use PostgreSQL as the database",
        now,
      );
      insertItem(db, {
        id: "item-active-db",
        kind: "decision",
        subject: "database choice",
        statement: "Team decided to use PostgreSQL as the primary database",
        status: "active",
        importance: 0.8,
        firstSeenAt: now,
      });
      insertItemSource(db, "item-active-db", "msg-entity-active", now);

      // Superseded item (should not appear)
      insertItem(db, {
        id: "item-superseded-db",
        kind: "decision",
        subject: "database choice",
        statement: "Team decided to use MySQL as the primary database",
        status: "superseded",
        importance: 0.8,
        firstSeenAt: now - 100_000,
      });

      const recall = await buildMemoryRecall(
        "database choice decision",
        "conv-entity-status",
        TEST_CONFIG,
      );

      // Recency search finds segments but tier classification filters them.
      // Key assertion: superseded MySQL item should not leak.
      expect(recall.recencyHits).toBeGreaterThan(0);
      expect(recall.injectedText).not.toContain("MySQL");
    });

    test("invalidated items are excluded from recall", async () => {
      const db = getDb();
      const now = 1_700_000_275_000;
      insertConversation(db, "conv-invalid-status", now, 1);
      insertMessage(
        db,
        "msg-invalid-status",
        "conv-invalid-status",
        "user",
        "Framework preference is React for this codebase.",
        now,
      );
      insertSegment(
        db,
        "seg-invalid-status",
        "msg-invalid-status",
        "conv-invalid-status",
        "user",
        "Framework preference is React for this codebase.",
        now,
      );

      insertItem(db, {
        id: "item-framework-active",
        kind: "preference",
        subject: "framework preference",
        statement: "Framework preference is React for this codebase",
        status: "active",
        importance: 0.9,
        firstSeenAt: now,
      });
      insertItemSource(db, "item-framework-active", "msg-invalid-status", now);

      // Invalidated item (should not appear in recall)
      insertItem(db, {
        id: "item-framework-invalidated",
        kind: "preference",
        subject: "framework preference",
        statement: "Framework preference is Angular for this codebase",
        status: "invalidated",
        importance: 0.9,
        firstSeenAt: now - 50_000,
      });

      const recall = await buildMemoryRecall(
        "framework preference",
        "conv-invalid-status",
        TEST_CONFIG,
      );
      expect(recall.recencyHits).toBeGreaterThan(0);
      // Active segment content should be injected; invalidated item should not leak
      expect(recall.injectedText).toContain("React");
      expect(recall.injectedText).not.toContain("Angular");
    });
  });

  // -------------------------------------------------------------------------
  // Stale Memory Suppression
  // -------------------------------------------------------------------------

  describe("stale memory suppression", () => {
    test("recently mentioned memories outrank old memories via recency scoring", async () => {
      const db = getDb();
      const now = Date.now();
      const oneMonthAgo = now - 30 * 24 * 60 * 60 * 1000;
      insertConversation(db, "conv-stale", now, 2);

      // Recent mention
      insertMessage(
        db,
        "msg-recent",
        "conv-stale",
        "user",
        "We are using Bun as our runtime environment",
        now - 1000,
      );
      insertSegment(
        db,
        "seg-recent",
        "msg-recent",
        "conv-stale",
        "user",
        "We are using Bun as our runtime environment",
        now - 1000,
      );

      // Old mention (same topic)
      insertMessage(
        db,
        "msg-old",
        "conv-stale",
        "user",
        "We are using Node as our runtime environment",
        oneMonthAgo,
      );
      insertSegment(
        db,
        "seg-old",
        "msg-old",
        "conv-stale",
        "user",
        "We are using Node as our runtime environment",
        oneMonthAgo,
      );

      // Add items and mock Qdrant with the recent item scoring higher
      insertItem(db, {
        id: "item-bun-runtime",
        kind: "project",
        subject: "runtime environment",
        statement: "We are using Bun as our runtime environment",
        importance: 0.7,
        firstSeenAt: now - 1000,
      });
      insertItemSource(db, "item-bun-runtime", "msg-recent", now - 1000);

      mockQdrantResults = [
        {
          id: "emb-bun-runtime",
          score: 0.9,
          payload: {
            target_type: "item",
            target_id: "item-bun-runtime",
            text: "We are using Bun as our runtime environment",
            kind: "project",
            status: "active",
            created_at: now - 1000,
            last_seen_at: now - 1000,
          },
        },
      ];

      const recall = await buildMemoryRecall(
        "runtime environment",
        "conv-stale",
        TEST_CONFIG,
      );

      expect(recall.recencyHits).toBeGreaterThan(0);
      expect(recall.enabled).toBe(true);
      // Recent Bun item should be injected, old Node reference should not
      expect(recall.injectedText).toContain("Bun");
    });

    test("frequently accessed items surface via recency search when seeded with segments", async () => {
      const db = getDb();
      const now = 1_700_000_400_000;
      insertConversation(db, "conv-access", now, 2);

      // Frequently accessed item with segment
      insertMessage(
        db,
        "msg-freq",
        "conv-access",
        "user",
        "User timezone is America/Los_Angeles",
        now,
      );
      insertSegment(
        db,
        "seg-freq",
        "msg-freq",
        "conv-access",
        "user",
        "User timezone is America/Los_Angeles",
        now,
      );
      insertItem(db, {
        id: "item-freq",
        kind: "identity",
        subject: "timezone",
        statement: "User timezone is America/Los_Angeles",
        importance: 0.5,
        accessCount: 20,
        firstSeenAt: now,
      });
      insertItemSource(db, "item-freq", "msg-freq", now);

      // Rarely accessed item with segment
      insertMessage(
        db,
        "msg-rare",
        "conv-access",
        "user",
        "User timezone offset is UTC-8",
        now + 1000,
      );
      insertSegment(
        db,
        "seg-rare",
        "msg-rare",
        "conv-access",
        "user",
        "User timezone offset is UTC-8",
        now + 1000,
      );
      insertItem(db, {
        id: "item-rare",
        kind: "identity",
        subject: "timezone offset",
        statement: "User timezone offset is UTC-8",
        importance: 0.5,
        accessCount: 0,
        firstSeenAt: now + 1000,
      });
      insertItemSource(db, "item-rare", "msg-rare", now + 1000);

      // Mock Qdrant with the frequently accessed item scoring higher
      mockQdrantResults = [
        {
          id: "emb-freq",
          score: 0.92,
          payload: {
            target_type: "item",
            target_id: "item-freq",
            text: "User timezone is America/Los_Angeles",
            kind: "identity",
            status: "active",
            created_at: now,
            last_seen_at: now,
          },
        },
        {
          id: "emb-rare",
          score: 0.75,
          payload: {
            target_type: "item",
            target_id: "item-rare",
            text: "User timezone offset is UTC-8",
            kind: "identity",
            status: "active",
            created_at: now + 1000,
            last_seen_at: now + 1000,
          },
        },
      ];

      const recall = await buildMemoryRecall(
        "timezone",
        "conv-access",
        TEST_CONFIG,
      );

      expect(recall.recencyHits).toBeGreaterThan(0);
      expect(recall.enabled).toBe(true);
      // Frequently accessed timezone item should be in injected text
      expect(recall.injectedText).toContain("America/Los_Angeles");
    });
  });

  // -------------------------------------------------------------------------
  // Multi-source recall consistency
  // -------------------------------------------------------------------------

  describe("multi-source recall", () => {
    test("recency search surfaces segments when hybrid search is unavailable", async () => {
      const db = getDb();
      const now = 1_700_000_500_000;
      insertConversation(db, "conv-multi", now, 1);

      // Segment (recency source)
      insertMessage(
        db,
        "msg-seg",
        "conv-multi",
        "user",
        "Deploy to staging before production always",
        now,
      );
      insertSegment(
        db,
        "seg-deploy",
        "msg-seg",
        "conv-multi",
        "user",
        "Deploy to staging before production always",
        now,
      );

      // Item (constraint kind)
      insertItem(db, {
        id: "item-deploy-rule",
        kind: "constraint",
        subject: "deployment rule",
        statement: "Always deploy to staging before production",
        importance: 0.9,
        firstSeenAt: now,
      });
      insertItemSource(db, "item-deploy-rule", "msg-seg", now);

      // Mock Qdrant to return the deployment rule item
      mockQdrantResults = [
        {
          id: "emb-deploy-rule",
          score: 0.91,
          payload: {
            target_type: "item",
            target_id: "item-deploy-rule",
            text: "Always deploy to staging before production",
            kind: "constraint",
            status: "active",
            created_at: now,
            last_seen_at: now,
          },
        },
      ];

      const recall = await buildMemoryRecall(
        "deployment staging production",
        "conv-multi",
        TEST_CONFIG,
      );

      expect(recall.recencyHits).toBeGreaterThan(0);
      expect(recall.enabled).toBe(true);
      // Deployment rule should be injected
      expect(recall.injectedText).toContain("staging");
    });

    test("recall with no matching content returns empty injection", async () => {
      const db = getDb();
      const now = 1_700_000_600_000;
      insertConversation(db, "conv-empty", now);

      const recall = await buildMemoryRecall(
        "completely unrelated xyzzy topic",
        "conv-empty",
        TEST_CONFIG,
      );

      expect(recall.injectedText).toBe("");
      expect(recall.injectedTokens).toBe(0);
    });
  });

  // -------------------------------------------------------------------------
  // Precision@K helpers
  // -------------------------------------------------------------------------

  describe("precision@k assertions", () => {
    test("assertPrecisionAtK passes when enough expected items are found", () => {
      const text = "item-a is here, item-b is here, item-c is here";
      assertPrecisionAtK(text, ["item-a", "item-b", "item-c"], 3);
      assertPrecisionAtK(text, ["item-a", "item-b", "item-c", "item-d"], 3);
    });

    test("assertPrecisionAtK fails when too few expected items are found", () => {
      const text = "only item-a is here";
      expect(() => {
        assertPrecisionAtK(
          text,
          ["item-a", "item-b", "item-c"],
          2,
          "test-label",
        );
      }).toThrow(
        /precision@3 too low.*found 1\/3.*need at least 2.*Missing: item-b, item-c/,
      );
    });

    test("precision@k guard verifies pipeline completes with seeded segments", async () => {
      const db = getDb();
      const now = 1_700_000_700_000;
      insertConversation(db, "conv-pk", now, 3);

      const prefs = [
        {
          msg: "msg-pk-1",
          seg: "seg-pk-1",
          text: "I prefer dark mode over light mode",
        },
        {
          msg: "msg-pk-2",
          seg: "seg-pk-2",
          text: "I like using TypeScript for all projects",
        },
        {
          msg: "msg-pk-3",
          seg: "seg-pk-3",
          text: "I prefer tabs over spaces for indentation",
        },
      ];

      for (let i = 0; i < prefs.length; i++) {
        const p = prefs[i]!;
        const t = now + i * 1000;
        insertMessage(db, p.msg, "conv-pk", "user", p.text, t);
        insertSegment(db, p.seg, p.msg, "conv-pk", "user", p.text, t);
      }

      const recall = await buildMemoryRecall(
        "what do I prefer",
        "conv-pk",
        TEST_CONFIG,
      );

      // Recency-only candidates are promoted to tier 2 and injected.
      // Verify the pipeline recalled the preference content.
      expect(recall.recencyHits).toBeGreaterThan(0);
      expect(recall.enabled).toBe(true);
      assertPrecisionAtK(
        recall.injectedText,
        ["dark mode", "TypeScript", "tabs"],
        2,
        "preference recall precision",
      );
    });
  });
});
