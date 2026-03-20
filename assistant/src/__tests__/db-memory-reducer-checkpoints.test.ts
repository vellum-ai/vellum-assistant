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

const testDir = mkdtempSync(join(tmpdir(), "memory-reducer-checkpoints-"));
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
  getConversationsDir: () => join(testDir, "conversations"),
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { initializeDb, resetDb } from "../memory/db.js";
import { getSqliteFrom } from "../memory/db-connection.js";
import { migrateMemoryReducerCheckpoints } from "../memory/migrations/187-memory-reducer-checkpoints.js";
import * as schema from "../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function getColumnInfo(
  raw: Database,
): Array<{ name: string; notnull: number }> {
  return raw.query(`PRAGMA table_info(conversations)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
}

function bootstrapPreCheckpointConversations(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      total_input_tokens INTEGER NOT NULL DEFAULT 0,
      total_output_tokens INTEGER NOT NULL DEFAULT 0,
      total_estimated_cost REAL NOT NULL DEFAULT 0,
      context_summary TEXT,
      context_compacted_message_count INTEGER NOT NULL DEFAULT 0,
      context_compacted_at INTEGER,
      conversation_type TEXT NOT NULL DEFAULT 'standard',
      source TEXT NOT NULL DEFAULT 'user',
      memory_scope_id TEXT NOT NULL DEFAULT 'default',
      origin_channel TEXT,
      origin_interface TEXT,
      fork_parent_conversation_id TEXT,
      fork_parent_message_id TEXT,
      is_auto_title INTEGER NOT NULL DEFAULT 1,
      schedule_job_id TEXT
    )
  `);
}

function removeTestDbFiles(): void {
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

describe("memory reducer checkpoint columns migration", () => {
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

  test("fresh DB initialization includes nullable reducer checkpoint columns", () => {
    initializeDb();

    const raw = new Database(dbPath);
    const columns = getColumnInfo(raw);

    const checkpointColumns = columns.filter(
      (c) =>
        c.name === "memory_reduced_through_message_id" ||
        c.name === "memory_dirty_tail_since_message_id" ||
        c.name === "memory_last_reduced_at",
    );

    expect(checkpointColumns).toHaveLength(3);
    expect(checkpointColumns.every((c) => c.notnull === 0)).toBe(true);

    raw.close();
  });

  test("migration upgrades the pre-checkpoint schema without disturbing existing rows", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPreCheckpointConversations(raw);
    raw.exec(/*sql*/ `
      INSERT INTO conversations (
        id,
        title,
        created_at,
        updated_at,
        conversation_type,
        source,
        memory_scope_id,
        is_auto_title
      ) VALUES (
        'conv-upgrade',
        'Existing conversation',
        ${now},
        ${now},
        'standard',
        'user',
        'default',
        1
      )
    `);

    migrateMemoryReducerCheckpoints(db);

    const columnNames = getColumnInfo(raw).map((c) => c.name);
    expect(columnNames).toContain("memory_reduced_through_message_id");
    expect(columnNames).toContain("memory_dirty_tail_since_message_id");
    expect(columnNames).toContain("memory_last_reduced_at");

    const row = raw
      .query(
        `SELECT id, title, memory_reduced_through_message_id, memory_dirty_tail_since_message_id, memory_last_reduced_at
         FROM conversations WHERE id = 'conv-upgrade'`,
      )
      .get() as {
      id: string;
      title: string | null;
      memory_reduced_through_message_id: string | null;
      memory_dirty_tail_since_message_id: string | null;
      memory_last_reduced_at: number | null;
    } | null;

    expect(row).toEqual({
      id: "conv-upgrade",
      title: "Existing conversation",
      memory_reduced_through_message_id: null,
      memory_dirty_tail_since_message_id: null,
      memory_last_reduced_at: null,
    });

    raw.close();
  });

  test("re-running the migration preserves populated checkpoint values", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPreCheckpointConversations(raw);
    raw.exec(/*sql*/ `
      INSERT INTO conversations (
        id,
        title,
        created_at,
        updated_at,
        conversation_type,
        source,
        memory_scope_id,
        is_auto_title
      ) VALUES (
        'conv-rerun',
        'Reduced conversation',
        ${now},
        ${now},
        'standard',
        'user',
        'default',
        1
      )
    `);

    migrateMemoryReducerCheckpoints(db);
    raw.exec(/*sql*/ `
      UPDATE conversations
      SET memory_reduced_through_message_id = 'msg-100',
          memory_dirty_tail_since_message_id = 'msg-101',
          memory_last_reduced_at = ${now}
      WHERE id = 'conv-rerun'
    `);

    expect(() => migrateMemoryReducerCheckpoints(db)).not.toThrow();

    const row = raw
      .query(
        `SELECT memory_reduced_through_message_id, memory_dirty_tail_since_message_id, memory_last_reduced_at
         FROM conversations WHERE id = 'conv-rerun'`,
      )
      .get() as {
      memory_reduced_through_message_id: string | null;
      memory_dirty_tail_since_message_id: string | null;
      memory_last_reduced_at: number | null;
    } | null;

    expect(row).toEqual({
      memory_reduced_through_message_id: "msg-100",
      memory_dirty_tail_since_message_id: "msg-101",
      memory_last_reduced_at: now,
    });

    raw.close();
  });

  test("getConversation exposes the new checkpoint fields as null for new rows", async () => {
    initializeDb();

    // Dynamic import to avoid circular module init issues — conversation-crud
    // depends on getDb being initialized which happens in initializeDb above.
    const { createConversation, getConversation } =
      await import("../memory/conversation-crud.js");

    const created = createConversation("Test conversation");
    const loaded = getConversation(created.id);

    expect(loaded).not.toBeNull();
    expect(loaded!.memoryReducedThroughMessageId).toBeNull();
    expect(loaded!.memoryDirtyTailSinceMessageId).toBeNull();
    expect(loaded!.memoryLastReducedAt).toBeNull();
  });
});
