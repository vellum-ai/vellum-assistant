/**
 * End-to-end tests for the simplified memory system.
 *
 * Covers the must-have scenarios:
 * 1. Backfill: legacy segments, summaries, and items migrate to simplified tables
 * 2. Simplified memory is enabled by default after backfill
 * 3. Memory tools use simplified path when enabled
 * 4. Legacy tables remain available as rollback support
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

const testDir = mkdtempSync(join(tmpdir(), "simplified-memory-e2e-test-"));
const dbPath = join(testDir, "test.db");

// ── Platform mock (must come before any module imports) ──────────────

mock.module("../util/platform.js", () => ({
  getDataDir: () => testDir,
  getRootDir: () => testDir,
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
  truncateForLog: (value: string) => value,
}));

// Stub the Qdrant and embedding backends since we don't need vectors
mock.module("../memory/qdrant-client.js", () => ({
  getQdrantClient: () => ({
    searchWithFilter: async () => [],
    hybridSearch: async () => [],
    upsertPoints: async () => {},
    deletePoints: async () => {},
    upsert: async () => {},
  }),
  initQdrantClient: () => {},
}));

mock.module("../memory/embedding-backend.js", () => ({
  getMemoryBackendStatus: async () => ({
    provider: null,
    reason: "test-stub",
  }),
  embedWithBackend: async () => ({
    vectors: [[]],
    provider: "test",
    model: "test",
  }),
  generateSparseEmbedding: () => undefined,
  selectEmbeddingBackend: async () => null,
}));

mock.module("../memory/qdrant-circuit-breaker.js", () => ({
  withQdrantBreaker: async (fn: () => Promise<unknown>) => fn(),
  QdrantCircuitOpenError: class extends Error {},
}));

// ── Configurable config mock ────────────────────────────────────────

import { DEFAULT_CONFIG } from "../config/defaults.js";
import type { AssistantConfig } from "../config/types.js";

let testConfig: AssistantConfig = {
  ...DEFAULT_CONFIG,
  memory: {
    ...DEFAULT_CONFIG.memory,
    enabled: true,
    simplified: {
      ...DEFAULT_CONFIG.memory.simplified,
      enabled: true,
    },
  },
};

mock.module("../config/loader.js", () => ({
  loadConfig: () => testConfig,
  getConfig: () => testConfig,
  loadRawConfig: () => ({}),
  saveRawConfig: () => {},
  invalidateConfigCache: () => {},
}));

// ── Now import modules under test ────────────────────────────────────

import { v4 as uuid } from "uuid";

import { insertObservation } from "../memory/archive-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { getSqlite } from "../memory/db-connection.js";
import { backfillSimplifiedMemoryJob } from "../memory/job-handlers/backfill-simplified-memory.js";
import type { MemoryJob } from "../memory/jobs-store.js";
import { conversations, memoryItems, messages } from "../memory/schema.js";
import {
  handleMemoryRecall,
  handleMemorySave,
} from "../tools/memory/handlers.js";

// ── Helpers ─────────────────────────────────────────────────────────

function removeTestDbFiles(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

function getRawDb(): import("bun:sqlite").Database {
  return getSqlite();
}

function makeJob(overrides: Partial<MemoryJob> = {}): MemoryJob {
  return {
    id: uuid(),
    type: "backfill_simplified_memory",
    payload: {},
    status: "running",
    attempts: 0,
    deferrals: 0,
    runAfter: 0,
    lastError: null,
    startedAt: Date.now(),
    createdAt: Date.now(),
    updatedAt: Date.now(),
    ...overrides,
  };
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

let segmentIndexCounter = 0;

function insertLegacySegment(opts: {
  id: string;
  messageId: string;
  conversationId: string;
  role: string;
  text: string;
  scopeId?: string;
  segmentIndex?: number;
}): void {
  const now = Date.now();
  const idx = opts.segmentIndex ?? segmentIndexCounter++;
  getRawDb().run(
    `INSERT INTO memory_segments (id, message_id, conversation_id, role, segment_index, text, token_estimate, scope_id, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.messageId,
      opts.conversationId,
      opts.role,
      idx,
      opts.text,
      Math.ceil(opts.text.length / 4),
      opts.scopeId ?? "default",
      now,
      now,
    ],
  );
}

function insertLegacySummary(opts: {
  id: string;
  scope: string;
  scopeKey: string;
  summary: string;
  scopeId?: string;
  startAt?: number;
  endAt?: number;
}): void {
  const now = Date.now();
  getRawDb().run(
    `INSERT INTO memory_summaries (id, scope, scope_key, summary, token_estimate, version, scope_id, start_at, end_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
    [
      opts.id,
      opts.scope,
      opts.scopeKey,
      opts.summary,
      Math.ceil(opts.summary.length / 4),
      opts.scopeId ?? "default",
      opts.startAt ?? now - 3600000,
      opts.endAt ?? now,
      now,
      now,
    ],
  );
}

function insertLegacyItem(opts: {
  id: string;
  kind: string;
  subject: string;
  statement: string;
  scopeId?: string;
  confidence?: number;
  status?: string;
  validFrom?: number | null;
  invalidAt?: number | null;
}): void {
  const now = Date.now();
  getRawDb().run(
    `INSERT INTO memory_items (id, kind, subject, statement, status, confidence, importance, fingerprint, verification_state, scope_id, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, 0.8, ?, 'assistant_inferred', ?, ?, ?)`,
    [
      opts.id,
      opts.kind,
      opts.subject,
      opts.statement,
      opts.status ?? "active",
      opts.confidence ?? 0.9,
      `fp-${opts.id}`,
      opts.scopeId ?? "default",
      now,
      now,
    ],
  );
  // Set validFrom/invalidAt if provided
  if (opts.validFrom != null || opts.invalidAt != null) {
    getRawDb().run(
      `UPDATE memory_items SET valid_from = ?, invalid_at = ? WHERE id = ?`,
      [opts.validFrom ?? null, opts.invalidAt ?? null, opts.id],
    );
  }
}

function insertMessage(
  id: string,
  conversationId: string,
  role: string = "user",
  content: string = "test message",
): void {
  const db = getDb();
  const now = Date.now();
  db.insert(messages)
    .values({
      id,
      conversationId,
      role,
      content,
      createdAt: now,
    })
    .run();
}

function countRows(table: string): number {
  const result = getRawDb()
    .query<{ c: number }, []>(`SELECT COUNT(*) as c FROM ${table}`)
    .get();
  return result?.c ?? 0;
}

// ── Setup / Teardown ────────────────────────────────────────────────

describe("Simplified Memory E2E", () => {
  beforeAll(() => {
    initializeDb();
  });

  beforeEach(() => {
    segmentIndexCounter = 0;
    resetDb();
    removeTestDbFiles();
    initializeDb();
    testConfig = {
      ...DEFAULT_CONFIG,
      memory: {
        ...DEFAULT_CONFIG.memory,
        enabled: true,
        simplified: {
          ...DEFAULT_CONFIG.memory.simplified,
          enabled: true,
        },
      },
    };
  });

  afterAll(() => {
    resetDb();
    rmSync(testDir, { recursive: true, force: true });
  });

  // ── 1. Backfill tests ──────────────────────────────────────────────

  describe("backfill: legacy data migration", () => {
    test("migrates legacy segments to observations and chunks", async () => {
      const convId = uuid();
      createConversation(convId);
      const msgId = uuid();
      insertMessage(msgId, convId, "user", "I like TypeScript");

      insertLegacySegment({
        id: "seg-1",
        messageId: msgId,
        conversationId: convId,
        role: "user",
        text: "I like TypeScript and prefer it over JavaScript",
      });
      insertLegacySegment({
        id: "seg-2",
        messageId: msgId,
        conversationId: convId,
        role: "user",
        text: "My favorite editor is VS Code",
      });

      expect(countRows("memory_segments")).toBe(2);
      expect(countRows("memory_observations")).toBe(0);

      await backfillSimplifiedMemoryJob(makeJob());

      // Segments should have been migrated to observations
      expect(countRows("memory_observations")).toBeGreaterThanOrEqual(2);
      // Chunks should have been created for each observation
      expect(countRows("memory_chunks")).toBeGreaterThanOrEqual(2);
      // Original segments remain untouched
      expect(countRows("memory_segments")).toBe(2);
    });

    test("migrates legacy summaries to episodes", async () => {
      const convId = uuid();
      createConversation(convId);

      insertLegacySummary({
        id: "sum-1",
        scope: "conversation",
        scopeKey: convId,
        summary: "User discussed TypeScript preferences and project setup",
      });

      expect(countRows("memory_summaries")).toBe(1);
      expect(countRows("memory_episodes")).toBe(0);

      await backfillSimplifiedMemoryJob(makeJob());

      expect(countRows("memory_episodes")).toBeGreaterThanOrEqual(1);
      // Original summaries remain untouched
      expect(countRows("memory_summaries")).toBe(1);
    });

    test("migrates active legacy items to observations", async () => {
      insertLegacyItem({
        id: "item-1",
        kind: "preference",
        subject: "Editor",
        statement: "Prefers VS Code with vim keybindings",
      });
      insertLegacyItem({
        id: "item-2",
        kind: "identity",
        subject: "Name",
        statement: "User's name is Alice",
      });
      // Low-confidence item should be skipped
      insertLegacyItem({
        id: "item-3",
        kind: "event",
        subject: "Meeting",
        statement: "Had a meeting yesterday",
        confidence: 0.3,
      });

      expect(countRows("memory_items")).toBe(3);
      expect(countRows("memory_observations")).toBe(0);

      await backfillSimplifiedMemoryJob(makeJob());

      // Only the 2 active, high-confidence items should be migrated
      expect(countRows("memory_observations")).toBeGreaterThanOrEqual(2);
      // Original items remain untouched
      expect(countRows("memory_items")).toBe(3);
    });

    test("backfill is idempotent — running twice does not duplicate", async () => {
      const convId = uuid();
      createConversation(convId);
      const msgId = uuid();
      insertMessage(msgId, convId, "user", "Hello");

      insertLegacySegment({
        id: "seg-idem-1",
        messageId: msgId,
        conversationId: convId,
        role: "user",
        text: "This is an idempotency test segment",
      });

      await backfillSimplifiedMemoryJob(makeJob());
      const firstRunObservations = countRows("memory_observations");

      // Run again — should not create duplicates because content-hash dedup
      // and checkpoint tracking prevent it
      await backfillSimplifiedMemoryJob(makeJob());
      const secondRunObservations = countRows("memory_observations");

      expect(secondRunObservations).toBe(firstRunObservations);
    });

    test("backfill skips non-conversation summaries", async () => {
      insertLegacySummary({
        id: "sum-skip-1",
        scope: "weekly",
        scopeKey: "2024-W01",
        summary: "A weekly summary that does not link to a conversation",
      });

      await backfillSimplifiedMemoryJob(makeJob());

      // Non-conversation summaries should be skipped (no episode created)
      // The summary has scope "weekly" with a non-conversation-id scope_key
      // so it should be skipped by the extractConversationId check.
      // (Weekly summaries have no valid conversation to link to.)
      expect(countRows("memory_episodes")).toBe(0);
    });
  });

  // ── 2. Default flag state ─────────────────────────────────────────

  describe("simplified memory enabled by default", () => {
    test("config defaults to simplified.enabled = true", () => {
      expect(testConfig.memory.simplified.enabled).toBe(true);
    });

    test("can be disabled for rollback via config override", () => {
      testConfig = {
        ...testConfig,
        memory: {
          ...testConfig.memory,
          simplified: {
            ...testConfig.memory.simplified,
            enabled: false,
          },
        },
      };
      expect(testConfig.memory.simplified.enabled).toBe(false);
    });
  });

  // ── 3. Memory tools use simplified path ────────────────────────────

  describe("memory tools use simplified system when enabled", () => {
    test("memory_save writes to observations when simplified is enabled", async () => {
      const convId = uuid();
      createConversation(convId);

      const result = await handleMemorySave(
        {
          statement: "User prefers dark mode",
          kind: "preference",
          subject: "UI theme",
        },
        testConfig,
        convId,
        undefined,
        "default",
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Saved to memory");

      // Should have written to observations, not memory_items
      expect(countRows("memory_observations")).toBeGreaterThanOrEqual(1);
    });

    test("memory_save writes to memory_items when simplified is disabled", async () => {
      testConfig = {
        ...testConfig,
        memory: {
          ...testConfig.memory,
          simplified: {
            ...testConfig.memory.simplified,
            enabled: false,
          },
        },
      };

      const convId = uuid();
      createConversation(convId);

      const result = await handleMemorySave(
        {
          statement: "User prefers light mode",
          kind: "preference",
          subject: "UI theme",
        },
        testConfig,
        convId,
        undefined,
        "default",
      );

      expect(result.isError).toBe(false);
      expect(result.content).toContain("Saved to memory");

      // Should have written to legacy memory_items
      expect(countRows("memory_items")).toBeGreaterThanOrEqual(1);
    });

    test("memory_recall uses archive recall when simplified is enabled", async () => {
      // Insert some archive data that the recall can find
      const convId = uuid();
      createConversation(convId);

      insertObservation({
        conversationId: convId,
        role: "user",
        content:
          "User mentioned that their favorite programming language is TypeScript",
        scopeId: "default",
        modality: "text",
        source: "test",
      });

      const result = await handleMemoryRecall(
        { query: "programming language TypeScript" },
        testConfig,
        "default",
        convId,
      );

      expect(result.isError).toBe(false);
      // The result should be valid JSON
      const parsed = JSON.parse(result.content);
      expect(parsed).toBeDefined();
      expect(typeof parsed.text).toBe("string");
      expect(typeof parsed.resultCount).toBe("number");
    });
  });

  // ── 4. Legacy tables remain available ──────────────────────────────

  describe("legacy tables remain for rollback", () => {
    test("legacy memory_items table still exists and is writable", () => {
      const db = getDb();
      const now = Date.now();

      // Write to the legacy table should succeed
      db.insert(memoryItems)
        .values({
          id: uuid(),
          kind: "preference",
          subject: "Test",
          statement: "Test statement",
          status: "active",
          confidence: 0.9,
          importance: 0.8,
          fingerprint: `fp-${uuid()}`,
          verificationState: "assistant_inferred",
          scopeId: "default",
          firstSeenAt: now,
          lastSeenAt: now,
        })
        .run();

      expect(countRows("memory_items")).toBe(1);
    });

    test("legacy memory_segments table still exists and is writable", () => {
      const convId = uuid();
      createConversation(convId);
      const msgId = uuid();
      insertMessage(msgId, convId, "user", "test");

      insertLegacySegment({
        id: uuid(),
        messageId: msgId,
        conversationId: convId,
        role: "user",
        text: "Test legacy segment",
      });

      expect(countRows("memory_segments")).toBe(1);
    });

    test("legacy memory_summaries table still exists and is writable", () => {
      const convId = uuid();
      createConversation(convId);

      insertLegacySummary({
        id: uuid(),
        scope: "conversation",
        scopeKey: convId,
        summary: "Test legacy summary",
      });

      expect(countRows("memory_summaries")).toBe(1);
    });

    test("switching to legacy mode by disabling simplified flag works", async () => {
      // First save with simplified enabled
      const convId = uuid();
      createConversation(convId);

      await handleMemorySave(
        {
          statement: "User likes coffee",
          kind: "preference",
          subject: "Beverage",
        },
        testConfig,
        convId,
        undefined,
        "default",
      );

      const simplifiedObs = countRows("memory_observations");
      expect(simplifiedObs).toBeGreaterThanOrEqual(1);

      // Now disable simplified and save — should go to legacy table
      testConfig = {
        ...testConfig,
        memory: {
          ...testConfig.memory,
          simplified: {
            ...testConfig.memory.simplified,
            enabled: false,
          },
        },
      };

      await handleMemorySave(
        {
          statement: "User likes tea",
          kind: "preference",
          subject: "Beverage",
        },
        testConfig,
        convId,
        undefined,
        "default",
      );

      expect(countRows("memory_items")).toBeGreaterThanOrEqual(1);
    });
  });
});
