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

const testDir = mkdtempSync(join(tmpdir(), "memory-archive-migration-"));
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
import { migrateMemoryArchiveTables } from "../memory/migrations/186-memory-archive.js";
import * as schema from "../memory/schema.js";

const ARCHIVE_TABLES = [
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

function hasIndex(raw: Database, indexName: string): boolean {
  const row = raw
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(indexName);
  return row != null;
}

function getColumnNames(raw: Database, tableName: string): string[] {
  return (
    raw.query(`PRAGMA table_info(${tableName})`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

/** Bootstrap the minimal prerequisite tables that the archive tables reference. */
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
}

function removeTestDbFiles(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

describe("memory archive migration (186)", () => {
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

  test("fresh DB initialization creates all three archive tables", () => {
    initializeDb();

    const raw = new Database(dbPath);
    for (const table of ARCHIVE_TABLES) {
      expect(tableExists(raw, table)).toBe(true);
    }
    raw.close();
  });

  test("fresh DB initialization creates prefetch indexes on archive tables", () => {
    initializeDb();

    const raw = new Database(dbPath);

    // memory_observations indexes
    expect(hasIndex(raw, "idx_memory_observations_scope_id")).toBe(true);
    expect(hasIndex(raw, "idx_memory_observations_conversation_id")).toBe(true);
    expect(hasIndex(raw, "idx_memory_observations_created_at")).toBe(true);

    // memory_chunks indexes
    expect(hasIndex(raw, "idx_memory_chunks_scope_id")).toBe(true);
    expect(hasIndex(raw, "idx_memory_chunks_observation_id")).toBe(true);
    expect(hasIndex(raw, "idx_memory_chunks_content_hash")).toBe(true);
    expect(hasIndex(raw, "idx_memory_chunks_created_at")).toBe(true);

    // memory_episodes indexes
    expect(hasIndex(raw, "idx_memory_episodes_scope_id")).toBe(true);
    expect(hasIndex(raw, "idx_memory_episodes_conversation_id")).toBe(true);
    expect(hasIndex(raw, "idx_memory_episodes_created_at")).toBe(true);

    raw.close();
  });

  test("fresh DB initialization includes correct columns on memory_observations", () => {
    initializeDb();

    const raw = new Database(dbPath);
    const columns = getColumnNames(raw, "memory_observations");

    expect(columns).toContain("id");
    expect(columns).toContain("scope_id");
    expect(columns).toContain("conversation_id");
    expect(columns).toContain("message_id");
    expect(columns).toContain("role");
    expect(columns).toContain("content");
    expect(columns).toContain("modality");
    expect(columns).toContain("source");
    expect(columns).toContain("created_at");

    raw.close();
  });

  test("fresh DB initialization includes contentHash on memory_chunks", () => {
    initializeDb();

    const raw = new Database(dbPath);
    const columns = getColumnNames(raw, "memory_chunks");

    expect(columns).toContain("content_hash");
    expect(columns).toContain("observation_id");
    expect(columns).toContain("token_estimate");

    raw.close();
  });

  test("fresh DB initialization includes source-link metadata on memory_episodes", () => {
    initializeDb();

    const raw = new Database(dbPath);
    const columns = getColumnNames(raw, "memory_episodes");

    expect(columns).toContain("source");
    expect(columns).toContain("title");
    expect(columns).toContain("summary");
    expect(columns).toContain("start_at");
    expect(columns).toContain("end_at");

    raw.close();
  });

  // ---------- Upgrade (migration on a pre-archive DB) ----------

  test("migration creates archive tables on a database that has no archive tables", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPrerequisiteTables(raw);

    for (const table of ARCHIVE_TABLES) {
      expect(tableExists(raw, table)).toBe(false);
    }

    migrateMemoryArchiveTables(db);

    for (const table of ARCHIVE_TABLES) {
      expect(tableExists(raw, table)).toBe(true);
    }

    raw.close();
  });

  // ---------- Re-run safety ----------

  test("re-running the migration is safe and preserves existing data", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPrerequisiteTables(raw);
    migrateMemoryArchiveTables(db);

    // Insert a conversation and an observation
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

    // Re-run should not throw
    expect(() => migrateMemoryArchiveTables(db)).not.toThrow();

    // Verify data is preserved
    const obs = raw
      .query(`SELECT id, content FROM memory_observations WHERE id = 'obs-1'`)
      .get() as { id: string; content: string } | null;
    expect(obs).toEqual({ id: "obs-1", content: "The sky is blue" });

    const chunk = raw
      .query(`SELECT id, content_hash FROM memory_chunks WHERE id = 'chunk-1'`)
      .get() as { id: string; content_hash: string } | null;
    expect(chunk).toEqual({ id: "chunk-1", content_hash: "abc123" });

    const ep = raw
      .query(`SELECT id, title FROM memory_episodes WHERE id = 'ep-1'`)
      .get() as { id: string; title: string } | null;
    expect(ep).toEqual({ id: "ep-1", title: "Sky color" });

    raw.close();
  });

  // ---------- Legacy table isolation ----------

  test("migration does not modify legacy memory tables", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPrerequisiteTables(raw);

    // Create legacy memory tables
    raw.exec(/*sql*/ `
      CREATE TABLE memory_segments (
        id TEXT PRIMARY KEY,
        message_id TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
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
      CREATE TABLE memory_items (
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

    // Capture pre-migration column sets
    const segmentColumnsBefore = getColumnNames(raw, "memory_segments");
    const itemColumnsBefore = getColumnNames(raw, "memory_items");

    migrateMemoryArchiveTables(db);

    // Legacy tables should be completely untouched
    const segmentColumnsAfter = getColumnNames(raw, "memory_segments");
    const itemColumnsAfter = getColumnNames(raw, "memory_items");

    expect(segmentColumnsAfter).toEqual(segmentColumnsBefore);
    expect(itemColumnsAfter).toEqual(itemColumnsBefore);

    raw.close();
  });

  // ---------- Unique constraint on content_hash ----------

  test("memory_chunks content_hash unique index prevents duplicate inserts within same scope", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPrerequisiteTables(raw);
    migrateMemoryArchiveTables(db);

    raw.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at)
      VALUES ('conv-dup', ${now}, ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO memory_observations (id, scope_id, conversation_id, role, content, modality, created_at)
      VALUES ('obs-dup', 'default', 'conv-dup', 'user', 'Duplicate test', 'text', ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO memory_chunks (id, scope_id, observation_id, content, token_estimate, content_hash, created_at)
      VALUES ('chunk-dup-1', 'default', 'obs-dup', 'Duplicate test', 3, 'hash-dup', ${now})
    `);

    // Same scope + content_hash should fail
    expect(() => {
      raw.exec(/*sql*/ `
        INSERT INTO memory_chunks (id, scope_id, observation_id, content, token_estimate, content_hash, created_at)
        VALUES ('chunk-dup-2', 'default', 'obs-dup', 'Duplicate test', 3, 'hash-dup', ${now})
      `);
    }).toThrow();

    raw.close();
  });
});
