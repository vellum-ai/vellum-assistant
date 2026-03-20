/**
 * Memory Recall Quality Tests (Simplified Archive Path)
 *
 * Validates recall quality against the simplified memory system:
 * - Archive recall via episodes, observations, and chunks
 * - Trigger classification (past-reference, analogy, strong prefetch)
 * - Keyword extraction and matching
 * - Empty recall returns no injection
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

import { v4 as uuid } from "uuid";

import { DEFAULT_CONFIG } from "../config/defaults.js";

const TEST_CONFIG = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => TEST_CONFIG,
  getConfig: () => TEST_CONFIG,
  invalidateConfigCache: () => {},
}));

import {
  buildArchiveRecall,
  classifyRecallTrigger,
  extractKeywords,
} from "../memory/archive-recall.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  memoryChunks,
  memoryEpisodes,
  memoryObservations,
} from "../memory/schema.js";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function insertConversation(
  db: ReturnType<typeof getDb>,
  id: string,
  createdAt: number,
) {
  db.run(`
    INSERT INTO conversations (
      id, title, created_at, updated_at, total_input_tokens, total_output_tokens,
      total_estimated_cost, context_summary, context_compacted_message_count,
      context_compacted_at
    ) VALUES (
      '${id}', 'Test Conversation', ${createdAt}, ${createdAt}, 0, 0,
      0, NULL, 0, NULL
    )
  `);
}

function insertMessage(
  db: ReturnType<typeof getDb>,
  id: string,
  conversationId: string,
  role: string,
  text: string,
  createdAt: number,
) {
  db.run(`
    INSERT INTO messages (id, conversation_id, role, content, created_at)
    VALUES ('${id}', '${conversationId}', '${role}',
      '${JSON.stringify([{ type: "text", text }]).replace(/'/g, "''")}',
      ${createdAt})
  `);
}

function insertObservation(
  db: ReturnType<typeof getDb>,
  opts: {
    id: string;
    scopeId: string;
    conversationId: string;
    messageId?: string;
    role: string;
    content: string;
    createdAt: number;
  },
) {
  db.insert(memoryObservations)
    .values({
      id: opts.id,
      scopeId: opts.scopeId,
      conversationId: opts.conversationId,
      messageId: opts.messageId ?? null,
      role: opts.role,
      content: opts.content,
      createdAt: opts.createdAt,
    })
    .run();
}

function insertChunk(
  db: ReturnType<typeof getDb>,
  opts: {
    id: string;
    scopeId: string;
    observationId: string;
    content: string;
    contentHash: string;
    createdAt: number;
  },
) {
  db.insert(memoryChunks)
    .values({
      id: opts.id,
      scopeId: opts.scopeId,
      observationId: opts.observationId,
      content: opts.content,
      contentHash: opts.contentHash,
      createdAt: opts.createdAt,
    })
    .run();
}

function insertEpisode(
  db: ReturnType<typeof getDb>,
  opts: {
    id: string;
    scopeId: string;
    conversationId: string;
    title: string;
    summary: string;
    createdAt: number;
  },
) {
  db.insert(memoryEpisodes)
    .values({
      id: opts.id,
      scopeId: opts.scopeId,
      conversationId: opts.conversationId,
      title: opts.title,
      summary: opts.summary,
      createdAt: opts.createdAt,
    })
    .run();
}

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("Memory Recall Quality (Simplified Archive)", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    const db = getDb();
    db.run("DELETE FROM memory_episodes");
    db.run("DELETE FROM memory_chunks");
    db.run("DELETE FROM memory_observations");
    db.run("DELETE FROM messages");
    db.run("DELETE FROM conversations");
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
  // Trigger Classification
  // -------------------------------------------------------------------------

  describe("trigger classification", () => {
    test("explicit past-reference patterns trigger recall", () => {
      expect(classifyRecallTrigger("do you remember what we discussed?", 0)).toBe(
        "explicit_past_reference",
      );
      expect(classifyRecallTrigger("what did I tell you last time?", 0)).toBe(
        "explicit_past_reference",
      );
    });

    test("analogy/debugging patterns trigger recall", () => {
      expect(classifyRecallTrigger("this is similar to that bug before", 0)).toBe(
        "analogy_debug",
      );
      expect(classifyRecallTrigger("I keep getting this error", 0)).toBe(
        "analogy_debug",
      );
    });

    test("strong prefetch triggers recall", () => {
      expect(classifyRecallTrigger("setup deployment pipeline", 2)).toBe(
        "strong_prefetch",
      );
    });

    test("unrelated query with no prefetch hits returns none", () => {
      expect(classifyRecallTrigger("hello there", 0)).toBe("none");
    });
  });

  // -------------------------------------------------------------------------
  // Keyword Extraction
  // -------------------------------------------------------------------------

  describe("keyword extraction", () => {
    test("filters short words and stop words", () => {
      const keywords = extractKeywords("I want to use TypeScript for my project");
      expect(keywords).toContain("typescript");
      expect(keywords).toContain("project");
      expect(keywords).not.toContain("want");
      expect(keywords).not.toContain("use");
    });

    test("deduplicates keywords", () => {
      const keywords = extractKeywords("TypeScript TypeScript project project");
      const unique = new Set(keywords);
      expect(keywords.length).toBe(unique.size);
    });
  });

  // -------------------------------------------------------------------------
  // Archive Recall
  // -------------------------------------------------------------------------

  describe("archive recall with seeded data", () => {
    test("episodes are recalled when user references past context", () => {
      const db = getDb();
      const now = 1_700_000_000_000;
      const convId = "conv-episode-recall";

      insertConversation(db, convId, now);
      insertMessage(db, "msg-1", convId, "user", "Deploy Kubernetes cluster", now);

      insertEpisode(db, {
        id: uuid(),
        scopeId: "default",
        conversationId: convId,
        title: "Kubernetes Deployment",
        summary: "Deployed a Kubernetes cluster on AWS with 3 worker nodes using EKS",
        createdAt: now,
      });

      const result = buildArchiveRecall(
        "default",
        "do you remember the Kubernetes deployment we discussed?",
      );

      expect(result.trigger).toBe("explicit_past_reference");
      expect(result.bullets.length).toBeGreaterThan(0);
      expect(result.text).toContain("supporting_recall");
      expect(result.text).toContain("Kubernetes");
    });

    test("observations are recalled on keyword match", () => {
      const db = getDb();
      const now = 1_700_000_100_000;
      const convId = "conv-obs-recall";

      insertConversation(db, convId, now);
      insertMessage(db, "msg-obs-1", convId, "user", "PostgreSQL setup", now);

      insertObservation(db, {
        id: uuid(),
        scopeId: "default",
        conversationId: convId,
        messageId: "msg-obs-1",
        role: "user",
        content: "User prefers PostgreSQL over MySQL for all database projects",
        createdAt: now,
      });

      const result = buildArchiveRecall(
        "default",
        "what did I say about PostgreSQL previously?",
      );

      expect(result.trigger).toBe("explicit_past_reference");
      expect(result.bullets.length).toBeGreaterThan(0);
      expect(result.text).toContain("PostgreSQL");
    });

    test("empty recall when no matching content exists", () => {
      const result = buildArchiveRecall(
        "default",
        "completely unrelated xyzzy topic",
      );

      expect(result.bullets).toHaveLength(0);
      expect(result.text).toBe("");
    });

    test("recall returns empty when trigger is none and no prefetch hits", () => {
      const result = buildArchiveRecall("default", "hello there");

      expect(result.trigger).toBe("none");
      expect(result.bullets).toHaveLength(0);
      expect(result.text).toBe("");
    });
  });

  // -------------------------------------------------------------------------
  // Scope Isolation
  // -------------------------------------------------------------------------

  describe("scope isolation", () => {
    test("recall only returns results from the requested scope", () => {
      const db = getDb();
      const now = 1_700_000_200_000;
      const convId = "conv-scope-test";

      insertConversation(db, convId, now);
      insertMessage(db, "msg-scope-1", convId, "user", "scope test", now);

      // Insert observation in scope "other"
      insertObservation(db, {
        id: uuid(),
        scopeId: "other",
        conversationId: convId,
        role: "user",
        content: "Secret deployment configuration for other scope",
        createdAt: now,
      });

      // Insert observation in scope "default"
      insertObservation(db, {
        id: uuid(),
        scopeId: "default",
        conversationId: convId,
        role: "user",
        content: "Deployment configuration for default scope",
        createdAt: now,
      });

      const resultDefault = buildArchiveRecall(
        "default",
        "do you remember the deployment configuration?",
      );
      const resultOther = buildArchiveRecall(
        "other",
        "do you remember the deployment configuration?",
      );

      // Default scope should find its observation
      if (resultDefault.bullets.length > 0) {
        expect(resultDefault.text).toContain("default scope");
        expect(resultDefault.text).not.toContain("other scope");
      }

      // Other scope should find its observation
      if (resultOther.bullets.length > 0) {
        expect(resultOther.text).toContain("other scope");
        expect(resultOther.text).not.toContain("default scope");
      }
    });
  });
});
