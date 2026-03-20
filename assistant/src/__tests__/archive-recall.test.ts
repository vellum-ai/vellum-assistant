/**
 * Tests for the archive recall module.
 *
 * Covers:
 * - Explicit artifact recall (past-reference triggers)
 * - Analogy/debugging-shaped recall
 * - Strong prefetch triggers
 * - Empty result omission (no `<supporting_recall>` when nothing found)
 * - Keyword extraction
 * - Rendering format
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

const testDir = mkdtempSync(join(tmpdir(), "archive-recall-test-"));
const dbPath = join(testDir, "test.db");

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => dbPath,
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

import {
  buildArchiveRecall,
  classifyRecallTrigger,
  extractKeywords,
  prefetchArchive,
  type RecallBullet,
  renderSupportingRecall,
} from "../memory/archive-recall.js";
import {
  insertCompactionEpisode,
  insertObservation,
} from "../memory/archive-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { conversations, messages } from "../memory/schema.js";

// ── Helpers ─────────────────────────────────────────────────────────

function removeTestDbFiles(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

function createConversation(id: string, title: string | null = null): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function createMessage(
  id: string,
  conversationId: string,
  role: string = "user",
  content: string = "test message",
): void {
  const db = getDb();
  db.insert(messages)
    .values({
      id,
      conversationId,
      role,
      content,
      createdAt: Date.now(),
    })
    .run();
}

// ── Test suite ──────────────────────────────────────────────────────

describe("Archive Recall", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    resetDb();
    removeTestDbFiles();
    initializeDb();
  });

  afterAll(() => {
    resetDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  // ─────────────────────────────────────────────────────────────────
  // classifyRecallTrigger
  // ─────────────────────────────────────────────────────────────────

  describe("classifyRecallTrigger", () => {
    test("detects explicit past-reference phrases", () => {
      expect(
        classifyRecallTrigger("Do you remember the API we discussed?", 0),
      ).toBe("explicit_past_reference");
      expect(classifyRecallTrigger("We talked about this last time", 0)).toBe(
        "explicit_past_reference",
      );
      expect(
        classifyRecallTrigger("As I mentioned earlier, the config is wrong", 0),
      ).toBe("explicit_past_reference");
      expect(
        classifyRecallTrigger("I previously told you about the bug", 0),
      ).toBe("explicit_past_reference");
    });

    test("detects analogy/debugging-shaped phrases", () => {
      expect(
        classifyRecallTrigger("This is similar to the issue we had", 0),
      ).toBe("analogy_debug");
      expect(classifyRecallTrigger("I keep getting this error", 0)).toBe(
        "analogy_debug",
      );
      expect(classifyRecallTrigger("Same problem as yesterday", 0)).toBe(
        "analogy_debug",
      );
    });

    test("detects strong prefetch hits", () => {
      expect(
        classifyRecallTrigger("How should I configure the database?", 2),
      ).toBe("strong_prefetch");
      expect(
        classifyRecallTrigger("How should I configure the database?", 5),
      ).toBe("strong_prefetch");
    });

    test("returns none for ordinary turns", () => {
      expect(classifyRecallTrigger("What is the capital of France?", 0)).toBe(
        "none",
      );
      expect(
        classifyRecallTrigger("Write a function to sort an array", 1),
      ).toBe("none");
    });

    test("explicit past-reference takes priority over analogy", () => {
      // "remember" matches past-reference, "same issue" matches analogy
      expect(
        classifyRecallTrigger("Do you remember the same issue we had?", 0),
      ).toBe("explicit_past_reference");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // extractKeywords
  // ─────────────────────────────────────────────────────────────────

  describe("extractKeywords", () => {
    test("extracts meaningful words >= 4 chars", () => {
      const kw = extractKeywords("How do I fix the authentication error?");
      expect(kw).toContain("authentication");
      expect(kw).toContain("error");
      // "how", "do", "I", "fix", "the" are too short or stop words
      expect(kw).not.toContain("how");
      expect(kw).not.toContain("the");
    });

    test("removes stop words", () => {
      const kw = extractKeywords("I want to make this very much better");
      expect(kw).not.toContain("want");
      expect(kw).not.toContain("very");
      expect(kw).not.toContain("much");
      expect(kw).toContain("better");
    });

    test("deduplicates keywords", () => {
      const kw = extractKeywords("error error error authentication");
      expect(kw.filter((w) => w === "error")).toHaveLength(1);
    });

    test("returns empty for short/stop-word-only input", () => {
      expect(extractKeywords("hi")).toEqual([]);
      expect(extractKeywords("the a an")).toEqual([]);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // renderSupportingRecall
  // ─────────────────────────────────────────────────────────────────

  describe("renderSupportingRecall", () => {
    test("renders bullets in <supporting_recall> tag", () => {
      const bullets: RecallBullet[] = [
        {
          text: "User prefers REST APIs",
          source: "observation",
          sourceId: "obs-1",
          conversationTitle: "API Discussion",
        },
        {
          text: "Deployed to production last week",
          source: "episode",
          sourceId: "ep-1",
        },
      ];

      const result = renderSupportingRecall(bullets);
      expect(result).toContain("<supporting_recall>");
      expect(result).toContain("</supporting_recall>");
      expect(result).toContain(
        "- User prefers REST APIs (from: API Discussion)",
      );
      expect(result).toContain("- Deployed to production last week");
      // No provenance for second bullet (no conversationTitle)
      expect(result).not.toContain("(from: undefined)");
      expect(result).not.toContain("(from: null)");
    });

    test("returns empty string for empty bullets", () => {
      expect(renderSupportingRecall([])).toBe("");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Explicit artifact recall
  // ─────────────────────────────────────────────────────────────────

  describe("explicit artifact recall", () => {
    test("recalls observations when user references past discussion", () => {
      const convId = uuid();
      const msgId = uuid();
      createConversation(convId, "Authentication Redesign");
      createMessage(msgId, convId);

      insertObservation({
        conversationId: convId,
        messageId: msgId,
        role: "user",
        content:
          "User wants to migrate authentication from JWT to session tokens",
        scopeId: "default",
      });

      const result = buildArchiveRecall(
        "default",
        "Do you remember what we discussed about authentication?",
      );

      expect(result.trigger).toBe("explicit_past_reference");
      expect(result.bullets.length).toBeGreaterThan(0);
      expect(result.text).toContain("<supporting_recall>");
      expect(result.text).toContain("authentication");
    });

    test("recalls episodes when user references past work", () => {
      const convId = uuid();
      createConversation(convId, "Database Migration Sprint");

      insertCompactionEpisode({
        scopeId: "default",
        conversationId: convId,
        title: "PostgreSQL Migration Planning",
        summary:
          "Discussed migrating from MySQL to PostgreSQL, decided on a phased approach starting with read replicas",
        tokenEstimate: 25,
        startAt: Date.now() - 86_400_000,
        endAt: Date.now() - 43_200_000,
      });

      const result = buildArchiveRecall(
        "default",
        "What did we talk about regarding the PostgreSQL migration?",
      );

      expect(result.trigger).toBe("explicit_past_reference");
      expect(result.bullets.length).toBeGreaterThan(0);
      expect(result.text).toContain("<supporting_recall>");
      expect(result.text).toContain("PostgreSQL");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Analogy/debugging-shaped recall
  // ─────────────────────────────────────────────────────────────────

  describe("analogy-shaped recall", () => {
    test("recalls when user reports a recurring issue", () => {
      const convId = uuid();
      const msgId = uuid();
      createConversation(convId, "Debugging Session");
      createMessage(msgId, convId);

      insertObservation({
        conversationId: convId,
        messageId: msgId,
        role: "user",
        content:
          "Connection timeout error when calling the payment gateway service",
        scopeId: "default",
      });

      const result = buildArchiveRecall(
        "default",
        "I keep getting a timeout error with the payment service",
      );

      expect(result.trigger).toBe("analogy_debug");
      expect(result.bullets.length).toBeGreaterThan(0);
      expect(result.text).toContain("<supporting_recall>");
      expect(result.text).toContain("timeout");
    });

    test("recalls similar past episodes for analogy queries", () => {
      const convId = uuid();
      createConversation(convId, "Infrastructure Issues");

      insertCompactionEpisode({
        scopeId: "default",
        conversationId: convId,
        title: "Redis Connection Pool Exhaustion",
        summary:
          "Debugged Redis connection pool exhaustion caused by missing connection.release() calls in the retry handler",
        tokenEstimate: 30,
        startAt: Date.now() - 172_800_000,
        endAt: Date.now() - 86_400_000,
      });

      const result = buildArchiveRecall(
        "default",
        "This is similar to the Redis connection issue we had",
      );

      expect(result.trigger).toBe("analogy_debug");
      expect(result.bullets.length).toBeGreaterThan(0);
      expect(result.text).toContain("Redis");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Empty result omission
  // ─────────────────────────────────────────────────────────────────

  describe("empty result omission", () => {
    test("returns empty text when no archive content exists", () => {
      const result = buildArchiveRecall(
        "default",
        "Do you remember what we discussed about quantum computing?",
      );

      expect(result.trigger).toBe("explicit_past_reference");
      expect(result.bullets).toHaveLength(0);
      expect(result.text).toBe("");
    });

    test("returns empty text for ordinary turns with no matches", () => {
      const result = buildArchiveRecall(
        "default",
        "Write a hello world program in Python",
      );

      expect(result.trigger).toBe("none");
      expect(result.bullets).toHaveLength(0);
      expect(result.text).toBe("");
    });

    test("does not emit <supporting_recall> when trigger fires but no data matches", () => {
      // Seed with unrelated data
      const convId = uuid();
      const msgId = uuid();
      createConversation(convId, "Cooking Tips");
      createMessage(msgId, convId);

      insertObservation({
        conversationId: convId,
        messageId: msgId,
        role: "user",
        content: "User enjoys Italian cooking with fresh basil",
        scopeId: "default",
      });

      // Ask about something completely unrelated
      const result = buildArchiveRecall(
        "default",
        "Do you remember what we discussed about Kubernetes deployments?",
      );

      expect(result.trigger).toBe("explicit_past_reference");
      expect(result.bullets).toHaveLength(0);
      expect(result.text).toBe("");
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Prefetch behavior
  // ─────────────────────────────────────────────────────────────────

  describe("prefetch", () => {
    test("returns hits from episodes and observations", () => {
      const convId = uuid();
      const msgId = uuid();
      createConversation(convId);
      createMessage(msgId, convId);

      insertObservation({
        conversationId: convId,
        messageId: msgId,
        role: "user",
        content: "User prefers TypeScript over JavaScript",
        scopeId: "default",
      });

      insertCompactionEpisode({
        scopeId: "default",
        conversationId: convId,
        title: "TypeScript Configuration",
        summary: "Set up strict TypeScript config with path aliases",
        tokenEstimate: 15,
        startAt: Date.now() - 3600_000,
        endAt: Date.now() - 1800_000,
      });

      const hits = prefetchArchive("default", "TypeScript configuration setup");
      expect(hits.length).toBeGreaterThan(0);
      expect(hits.some((h) => h.source === "episode")).toBe(true);
      expect(hits.some((h) => h.source === "observation")).toBe(true);
    });

    test("returns empty for no matches", () => {
      const hits = prefetchArchive("default", "xyzzy nonexistent topic");
      expect(hits).toHaveLength(0);
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Bullet cap and deduplication
  // ─────────────────────────────────────────────────────────────────

  describe("bullet cap and dedup", () => {
    test("returns at most 3 bullets", () => {
      const convId = uuid();
      createConversation(convId);

      // Insert 5 distinct observations
      for (let i = 0; i < 5; i++) {
        const msgId = uuid();
        createMessage(msgId, convId);
        insertObservation({
          conversationId: convId,
          messageId: msgId,
          role: "user",
          content: `Authentication fact number ${i}: uses OAuth2 flow variant ${i}`,
          scopeId: "default",
        });
      }

      const result = buildArchiveRecall(
        "default",
        "Do you remember what authentication method we use?",
      );

      expect(result.trigger).toBe("explicit_past_reference");
      expect(result.bullets.length).toBeLessThanOrEqual(3);
    });

    test("deduplicates identical content from different sources", () => {
      const convId = uuid();
      const msgId = uuid();
      createConversation(convId);
      createMessage(msgId, convId);

      // Insert the same content as both an observation and in an episode
      const content = "User prefers dark mode for all development tools";
      insertObservation({
        conversationId: convId,
        messageId: msgId,
        role: "user",
        content,
        scopeId: "default",
      });

      insertCompactionEpisode({
        scopeId: "default",
        conversationId: convId,
        title: "Development Preferences",
        summary: content,
        tokenEstimate: 10,
        startAt: Date.now() - 3600_000,
        endAt: Date.now() - 1800_000,
      });

      const result = buildArchiveRecall(
        "default",
        "Do you recall my preference for dark mode development tools?",
      );

      // Should have bullets but content should not be duplicated
      if (result.bullets.length > 1) {
        const texts = result.bullets.map((b) => b.text.toLowerCase());
        // Each bullet text should be distinct
        const uniqueTexts = new Set(texts);
        expect(uniqueTexts.size).toBe(texts.length);
      }
    });
  });

  // ─────────────────────────────────────────────────────────────────
  // Scope isolation
  // ─────────────────────────────────────────────────────────────────

  describe("scope isolation", () => {
    test("only returns results from the requested scope", () => {
      const convId = uuid();
      const msgId = uuid();
      createConversation(convId);
      createMessage(msgId, convId);

      insertObservation({
        conversationId: convId,
        messageId: msgId,
        role: "user",
        content: "Deployment uses Kubernetes with Helm charts",
        scopeId: "other-scope",
      });

      const result = buildArchiveRecall(
        "default",
        "Do you remember our Kubernetes deployment setup?",
      );

      // Should trigger but find no results in "default" scope
      expect(result.trigger).toBe("explicit_past_reference");
      expect(result.bullets).toHaveLength(0);
      expect(result.text).toBe("");
    });
  });
});
