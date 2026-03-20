import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import {
  afterAll,
  afterEach,
  beforeEach,
  describe,
  expect,
  mock,
  test,
} from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

const testDir = mkdtempSync(join(tmpdir(), "drop-legacy-memory-"));
const dbPath = join(testDir, "test.db");
const originalBunTest = process.env.BUN_TEST;

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

import { initializeDb, resetDb } from "../memory/db.js";
import { getSqliteFrom } from "../memory/db-connection.js";
import { migrateDropLegacyMemorySystem } from "../memory/migrations/189-drop-legacy-memory-system.js";
import * as schema from "../memory/schema.js";

const LEGACY_TABLES = [
  "memory_items",
  "memory_item_sources",
  "memory_segments",
  "memory_summaries",
] as const;

const SIMPLIFIED_TABLES = [
  "memory_observations",
  "memory_chunks",
  "memory_episodes",
] as const;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function tableExists(raw: Database, tableName: string): boolean {
  const row = raw
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(tableName);
  return row != null;
}

function removeTestDbFiles(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

/** Bootstrap prerequisite tables and legacy memory tables for upgrade tests. */
function bootstrapPrerequisiteTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      created_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_embeddings (
      id TEXT PRIMARY KEY,
      target_type TEXT NOT NULL,
      target_id TEXT NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      dimensions INTEGER NOT NULL,
      vector_json TEXT,
      vector_blob BLOB,
      content_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_embeddings_target_provider_model
    ON memory_embeddings(target_type, target_id, provider, model)
  `);
}

function createLegacyTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_segments (
      id TEXT PRIMARY KEY,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      segment_index INTEGER NOT NULL,
      text TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      scope_id TEXT NOT NULL DEFAULT 'default',
      content_hash TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_segments_scope_id ON memory_segments(scope_id)
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_items (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      subject TEXT NOT NULL,
      statement TEXT NOT NULL,
      status TEXT NOT NULL,
      confidence REAL NOT NULL,
      fingerprint TEXT NOT NULL,
      scope_id TEXT NOT NULL DEFAULT 'default',
      first_seen_at INTEGER NOT NULL,
      last_seen_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_items_scope_id ON memory_items(scope_id)
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_items_fingerprint ON memory_items(fingerprint)
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_item_sources (
      memory_item_id TEXT NOT NULL REFERENCES memory_items(id) ON DELETE CASCADE,
      message_id TEXT NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
      evidence TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_item_sources_memory_item_id ON memory_item_sources(memory_item_id)
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_summaries (
      id TEXT PRIMARY KEY,
      scope TEXT NOT NULL,
      scope_key TEXT NOT NULL,
      summary TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      version INTEGER NOT NULL DEFAULT 1,
      scope_id TEXT NOT NULL DEFAULT 'default',
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX IF NOT EXISTS idx_memory_summaries_scope_id ON memory_summaries(scope_id)
  `);
  raw.exec(/*sql*/ `
    CREATE UNIQUE INDEX IF NOT EXISTS idx_memory_summaries_scope_scope_key ON memory_summaries(scope, scope_key)
  `);
}

function createSimplifiedMemoryTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_observations (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL DEFAULT 'default',
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      message_id TEXT,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      modality TEXT NOT NULL DEFAULT 'text',
      source TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_chunks (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL DEFAULT 'default',
      observation_id TEXT NOT NULL REFERENCES memory_observations(id) ON DELETE CASCADE,
      content TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      content_hash TEXT NOT NULL,
      created_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_episodes (
      id TEXT PRIMARY KEY,
      scope_id TEXT NOT NULL DEFAULT 'default',
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      summary TEXT NOT NULL,
      token_estimate INTEGER NOT NULL,
      source TEXT,
      start_at INTEGER NOT NULL,
      end_at INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

describe("drop legacy memory system migration (189)", () => {
  beforeEach(() => {
    process.env.BUN_TEST = "0";
    resetDb();
    removeTestDbFiles();
  });

  afterEach(() => {
    resetDb();
    removeTestDbFiles();
  });

  afterAll(() => {
    if (originalBunTest === undefined) {
      delete process.env.BUN_TEST;
    } else {
      process.env.BUN_TEST = originalBunTest;
    }
    resetDb();
    removeTestDbFiles();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* best effort */
    }
  });

  // ---------- Fresh init ----------

  test("fresh DB initialization does not create legacy tables", () => {
    initializeDb();

    const raw = new Database(dbPath);
    for (const table of LEGACY_TABLES) {
      expect(tableExists(raw, table)).toBe(false);
    }
    raw.close();
  });

  test("fresh DB initialization preserves simplified-memory tables", () => {
    initializeDb();

    const raw = new Database(dbPath);
    for (const table of SIMPLIFIED_TABLES) {
      expect(tableExists(raw, table)).toBe(true);
    }
    raw.close();
  });

  // ---------- Upgrade (migration on a pre-existing DB with legacy tables) ----------

  test("migration drops legacy tables on an upgraded database", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPrerequisiteTables(raw);
    createLegacyTables(raw);

    // Verify legacy tables exist before migration
    for (const table of LEGACY_TABLES) {
      expect(tableExists(raw, table)).toBe(true);
    }

    migrateDropLegacyMemorySystem(db);

    // All legacy tables should be gone
    for (const table of LEGACY_TABLES) {
      expect(tableExists(raw, table)).toBe(false);
    }

    raw.close();
  });

  test("migration purges legacy embedding target types", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPrerequisiteTables(raw);
    createLegacyTables(raw);

    // Insert embeddings for legacy target types
    raw.exec(/*sql*/ `
      INSERT INTO memory_embeddings (id, target_type, target_id, provider, model, dimensions, created_at, updated_at)
      VALUES ('emb-item-1', 'item', 'item-1', 'test', 'test-model', 384, ${now}, ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO memory_embeddings (id, target_type, target_id, provider, model, dimensions, created_at, updated_at)
      VALUES ('emb-seg-1', 'segment', 'seg-1', 'test', 'test-model', 384, ${now}, ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO memory_embeddings (id, target_type, target_id, provider, model, dimensions, created_at, updated_at)
      VALUES ('emb-sum-1', 'summary', 'sum-1', 'test', 'test-model', 384, ${now}, ${now})
    `);

    // Insert an embedding for a non-legacy target type (should be preserved)
    raw.exec(/*sql*/ `
      INSERT INTO memory_embeddings (id, target_type, target_id, provider, model, dimensions, created_at, updated_at)
      VALUES ('emb-chunk-1', 'chunk', 'chunk-1', 'test', 'test-model', 384, ${now}, ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO memory_embeddings (id, target_type, target_id, provider, model, dimensions, created_at, updated_at)
      VALUES ('emb-obs-1', 'observation', 'obs-1', 'test', 'test-model', 384, ${now}, ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO memory_embeddings (id, target_type, target_id, provider, model, dimensions, created_at, updated_at)
      VALUES ('emb-ep-1', 'episode', 'ep-1', 'test', 'test-model', 384, ${now}, ${now})
    `);

    migrateDropLegacyMemorySystem(db);

    // Legacy embeddings should be deleted
    const legacyCount = raw
      .query(
        `SELECT COUNT(*) AS c FROM memory_embeddings WHERE target_type IN ('item', 'segment', 'summary')`,
      )
      .get() as { c: number };
    expect(legacyCount.c).toBe(0);

    // Non-legacy embeddings should be preserved
    const nonLegacyCount = raw
      .query(
        `SELECT COUNT(*) AS c FROM memory_embeddings WHERE target_type IN ('chunk', 'observation', 'episode')`,
      )
      .get() as { c: number };
    expect(nonLegacyCount.c).toBe(3);

    raw.close();
  });

  // ---------- Re-run safety ----------

  test("re-running the migration is safe (idempotent)", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPrerequisiteTables(raw);
    createLegacyTables(raw);

    // First run
    migrateDropLegacyMemorySystem(db);

    // Second run should not throw
    expect(() => migrateDropLegacyMemorySystem(db)).not.toThrow();

    // Tables should still be gone
    for (const table of LEGACY_TABLES) {
      expect(tableExists(raw, table)).toBe(false);
    }

    raw.close();
  });

  test("re-run on a DB that never had legacy tables is safe", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPrerequisiteTables(raw);
    // No legacy tables created

    expect(() => migrateDropLegacyMemorySystem(db)).not.toThrow();

    raw.close();
  });

  // ---------- Simplified-memory table preservation ----------

  test("migration preserves simplified-memory tables and their data", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPrerequisiteTables(raw);
    createLegacyTables(raw);
    createSimplifiedMemoryTables(raw);

    // Insert test data into simplified-memory tables
    raw.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at)
      VALUES ('conv-1', ${now}, ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO memory_observations (id, scope_id, conversation_id, role, content, modality, created_at)
      VALUES ('obs-1', 'default', 'conv-1', 'user', 'The sky is blue', 'text', ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO memory_chunks (id, scope_id, observation_id, content, token_estimate, content_hash, created_at)
      VALUES ('chunk-1', 'default', 'obs-1', 'The sky is blue', 5, 'abc123', ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO memory_episodes (id, scope_id, conversation_id, title, summary, token_estimate, source, start_at, end_at, created_at, updated_at)
      VALUES ('ep-1', 'default', 'conv-1', 'Sky color', 'User mentioned sky is blue', 8, 'vellum', ${now}, ${now}, ${now}, ${now})
    `);

    migrateDropLegacyMemorySystem(db);

    // Simplified-memory tables should still exist
    for (const table of SIMPLIFIED_TABLES) {
      expect(tableExists(raw, table)).toBe(true);
    }

    // Data should be preserved
    const obs = raw
      .query(`SELECT id, content FROM memory_observations WHERE id = 'obs-1'`)
      .get() as { id: string; content: string } | null;
    expect(obs).toEqual({ id: "obs-1", content: "The sky is blue" });

    const chunk = raw
      .query(
        `SELECT id, content_hash FROM memory_chunks WHERE id = 'chunk-1'`,
      )
      .get() as { id: string; content_hash: string } | null;
    expect(chunk).toEqual({ id: "chunk-1", content_hash: "abc123" });

    const ep = raw
      .query(`SELECT id, title FROM memory_episodes WHERE id = 'ep-1'`)
      .get() as { id: string; title: string } | null;
    expect(ep).toEqual({ id: "ep-1", title: "Sky color" });

    raw.close();
  });

  // ---------- Memory embeddings table preserved ----------

  test("migration preserves memory_embeddings table itself", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPrerequisiteTables(raw);
    createLegacyTables(raw);

    migrateDropLegacyMemorySystem(db);

    expect(tableExists(raw, "memory_embeddings")).toBe(true);

    raw.close();
  });
});
