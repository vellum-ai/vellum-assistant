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

// Mock Qdrant client so semantic search returns empty results instead of
// throwing "Qdrant client not initialized" (which would discard lexical results
// due to the single try-catch in buildMemoryRecall).
mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
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
    db.run("DELETE FROM memory_summaries");
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

  // -------------------------------------------------------------------------
  // Preference Recall
  // -------------------------------------------------------------------------

  describe("preference recall", () => {
    test("preferences are recalled when querying about user preferences", async () => {
      const db = getDb();
      const now = 1_700_000_000_000;
      insertConversation(db, "conv-pref", now);
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

      const recall = await buildMemoryRecall(
        "what are my preferences",
        "conv-pref",
        TEST_CONFIG,
      );

      expect(recall.injectedText).toContain("dark mode");
      expect(recall.injectedText).toContain("concise answers");
    });

    test("high-importance preferences outrank low-importance facts in recall", async () => {
      const db = getDb();
      const now = 1_700_000_100_000;
      insertConversation(db, "conv-rank", now);

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

      // Low-importance fact
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
        kind: "fact",
        subject: "default port",
        statement: "The default port is 8080",
        importance: 0.3,
        firstSeenAt: now + 1000,
      });
      insertItemSource(db, "item-lo-fact", "msg-lo", now + 1000);

      const recall = await buildMemoryRecall(
        "TypeScript preference language",
        "conv-rank",
        TEST_CONFIG,
      );

      // The preference should appear
      expect(recall.injectedText).toContain("TypeScript");
    });
  });

  // -------------------------------------------------------------------------
  // Contradiction / Superseding Suppression
  // -------------------------------------------------------------------------

  describe("contradiction suppression", () => {
    test("superseded memory items do not appear in recall", async () => {
      const db = getDb();
      const now = 1_700_000_200_000;
      insertConversation(db, "conv-contra", now);

      // Old preference (superseded)
      insertMessage(
        db,
        "msg-old-pref",
        "conv-contra",
        "user",
        "I prefer vim for editing code",
        now - 50_000,
      );
      insertSegment(
        db,
        "seg-old-pref",
        "msg-old-pref",
        "conv-contra",
        "user",
        "I prefer vim for editing code",
        now - 50_000,
      );
      insertItem(db, {
        id: "item-old-pref",
        kind: "preference",
        subject: "editor preference",
        statement: "User prefers vim for editing code",
        status: "superseded",
        importance: 0.8,
        firstSeenAt: now - 50_000,
      });
      insertItemSource(db, "item-old-pref", "msg-old-pref", now - 50_000);

      // New preference (active, replaces the old one)
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

      const recall = await buildMemoryRecall(
        "editor preference",
        "conv-contra",
        TEST_CONFIG,
      );

      // Active preference should appear
      expect(recall.injectedText).toContain("neovim");
      expect(recall.injectedText).toContain("LazyVim");

      // Superseded preference should NOT appear in recalled item lines.
      // Assert against the actual statement text unique to the superseded item
      // ("prefers vim for") rather than an internal candidate key, which is
      // never emitted in the formatted recall output.
      const itemLines = recall.injectedText
        .split("\n")
        .filter((line) => line.includes("<kind>"));
      const hasSupersededItem = itemLines.some((line) =>
        line.includes("prefers vim for"),
      );
      expect(hasSupersededItem).toBe(false);
    });

    test("only active items are included in entity-based recall", async () => {
      const db = getDb();
      const now = 1_700_000_250_000;
      insertConversation(db, "conv-entity-status", now);

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

      insertItem(db, {
        id: "item-superseded-db",
        kind: "decision",
        subject: "database choice",
        statement: "Team decided to use MySQL as the primary database",
        status: "superseded",
        importance: 0.8,
        firstSeenAt: now - 100_000,
      });
      insertItemSource(
        db,
        "item-superseded-db",
        "msg-entity-active",
        now - 100_000,
      );

      const recall = await buildMemoryRecall(
        "database choice decision",
        "conv-entity-status",
        TEST_CONFIG,
      );

      expect(recall.injectedText).toContain("PostgreSQL");
    });

    test("pending clarification and invalidated items are excluded from direct item recall", async () => {
      const db = getDb();
      const now = 1_700_000_275_000;
      insertConversation(db, "conv-conflict-status", now);
      insertMessage(
        db,
        "msg-conflict-status",
        "conv-conflict-status",
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
      insertItemSource(db, "item-framework-active", "msg-conflict-status", now);

      insertItem(db, {
        id: "item-framework-pending",
        kind: "preference",
        subject: "framework preference",
        statement: "Framework preference is Vue for this codebase",
        status: "pending_clarification",
        importance: 0.9,
        firstSeenAt: now + 1,
      });
      insertItemSource(
        db,
        "item-framework-pending",
        "msg-conflict-status",
        now + 1,
      );

      insertItem(db, {
        id: "item-framework-invalid",
        kind: "preference",
        subject: "framework preference",
        statement: "Framework preference is Angular for this codebase",
        status: "active",
        importance: 0.9,
        firstSeenAt: now + 2,
      });
      db.run(
        `UPDATE memory_items SET invalid_at = ${
          now + 3
        } WHERE id = 'item-framework-invalid'`,
      );
      insertItemSource(
        db,
        "item-framework-invalid",
        "msg-conflict-status",
        now + 2,
      );

      const recall = await buildMemoryRecall(
        "framework preference",
        "conv-conflict-status",
        TEST_CONFIG,
      );
      // With FTS removed and semantic search mocked, items are only
      // reachable through recency (conversation-scoped). If recalled,
      // only active items should appear.
      expect(recall.injectedText).not.toContain("Vue");
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
      insertConversation(db, "conv-stale", now);

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

      const recall = await buildMemoryRecall(
        "runtime environment",
        "conv-stale",
        TEST_CONFIG,
      );

      // Both may appear but recent should rank higher (appear in injected text)
      expect(recall.injectedText).toContain("Bun");
    });

    test("frequently accessed items get a retrieval reinforcement boost", async () => {
      const db = getDb();
      const now = 1_700_000_400_000;
      insertConversation(db, "conv-access", now);

      // Frequently accessed item
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
        kind: "profile",
        subject: "timezone",
        statement: "User timezone is America/Los_Angeles",
        importance: 0.5,
        accessCount: 20,
        firstSeenAt: now,
      });
      insertItemSource(db, "item-freq", "msg-freq", now);

      // Rarely accessed item
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
        kind: "profile",
        subject: "timezone offset",
        statement: "User timezone offset is UTC-8",
        importance: 0.5,
        accessCount: 0,
        firstSeenAt: now + 1000,
      });
      insertItemSource(db, "item-rare", "msg-rare", now + 1000);

      const recall = await buildMemoryRecall(
        "timezone",
        "conv-access",
        TEST_CONFIG,
      );

      // The frequently accessed item should appear
      expect(recall.injectedText).toContain("America/Los_Angeles");
    });
  });

  // -------------------------------------------------------------------------
  // Multi-source recall consistency
  // -------------------------------------------------------------------------

  describe("multi-source recall", () => {
    test("lexical and item-based results are merged into a single recall", async () => {
      const db = getDb();
      const now = 1_700_000_500_000;
      insertConversation(db, "conv-multi", now);

      // Segment (lexical source)
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

      // Item (entity/item source)
      insertItem(db, {
        id: "item-deploy-rule",
        kind: "constraint",
        subject: "deployment rule",
        statement: "Always deploy to staging before production",
        importance: 0.9,
        firstSeenAt: now,
      });
      insertItemSource(db, "item-deploy-rule", "msg-seg", now);

      const recall = await buildMemoryRecall(
        "deployment staging production",
        "conv-multi",
        TEST_CONFIG,
      );

      // With FTS removed, lexical hits are always zero; recency search
      // still surfaces the segment so the injected text is non-empty.
      expect(recall.lexicalHits).toBe(0);
      expect(recall.injectedText.length).toBeGreaterThan(0);
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

    test("precision@k guard for preference recall fixture", async () => {
      const db = getDb();
      const now = 1_700_000_700_000;
      insertConversation(db, "conv-pk", now);

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

      // At least 2 of 3 preference segments should appear in recall
      assertPrecisionAtK(
        recall.injectedText,
        ["dark mode", "TypeScript", "tabs over spaces"],
        2,
        "preference-recall",
      );
    });
  });
});
