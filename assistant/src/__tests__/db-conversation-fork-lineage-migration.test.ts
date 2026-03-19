import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

const testDir = mkdtempSync(join(tmpdir(), "conversation-fork-lineage-"));
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
import { migrateConversationForkLineage } from "../memory/migrations/183-add-conversation-fork-lineage.js";
import * as schema from "../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function getColumnNames(raw: Database): string[] {
  return (
    raw.query(`PRAGMA table_info(conversations)`).all() as Array<{ name: string }>
  ).map((column) => column.name);
}

function hasIndex(raw: Database, indexName: string): boolean {
  const row = raw
    .query(`SELECT 1 FROM sqlite_master WHERE type = 'index' AND name = ?`)
    .get(indexName);
  return row != null;
}

function bootstrapPreLineageConversations(raw: Database): void {
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
      is_auto_title INTEGER NOT NULL DEFAULT 1,
      schedule_job_id TEXT
    )
  `);
}

function removeTestDbFiles(): void {
  resetDb();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

describe("conversation fork lineage migration", () => {
  beforeEach(() => {
    process.env.BUN_TEST = "0";
    removeTestDbFiles();
  });

  afterAll(() => {
    process.env.BUN_TEST = originalBunTest;
    removeTestDbFiles();
    try {
      rmSync(testDir, { recursive: true });
    } catch {
      /* best effort */
    }
  });

  test("fresh DB initialization includes nullable lineage columns and parent lookup index", () => {
    initializeDb();

    const raw = new Database(dbPath);
    const columns = getColumnNames(raw);

    expect(columns).toContain("fork_parent_conversation_id");
    expect(columns).toContain("fork_parent_message_id");
    expect(hasIndex(raw, "idx_conversations_fork_parent_conversation_id")).toBe(
      true,
    );

    const forkColumns = (
      raw.query(`PRAGMA table_info(conversations)`).all() as Array<{
        name: string;
        notnull: number;
      }>
    ).filter(
      (column) =>
        column.name === "fork_parent_conversation_id" ||
        column.name === "fork_parent_message_id",
    );

    expect(forkColumns).toHaveLength(2);
    expect(forkColumns.every((column) => column.notnull === 0)).toBe(true);
    raw.close();
  });

  test("migration upgrades the previous schema without disturbing existing conversation rows", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPreLineageConversations(raw);
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

    migrateConversationForkLineage(db);

    expect(getColumnNames(raw)).toContain("fork_parent_conversation_id");
    expect(getColumnNames(raw)).toContain("fork_parent_message_id");
    expect(hasIndex(raw, "idx_conversations_fork_parent_conversation_id")).toBe(
      true,
    );

    const row = raw
      .query(
        `SELECT id, title, fork_parent_conversation_id, fork_parent_message_id FROM conversations WHERE id = 'conv-upgrade'`,
      )
      .get() as {
      id: string;
      title: string | null;
      fork_parent_conversation_id: string | null;
      fork_parent_message_id: string | null;
    } | null;

    expect(row).toEqual({
      id: "conv-upgrade",
      title: "Existing conversation",
      fork_parent_conversation_id: null,
      fork_parent_message_id: null,
    });
  });

  test("re-running the migration preserves existing lineage data", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPreLineageConversations(raw);
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
        'Forked conversation',
        ${now},
        ${now},
        'standard',
        'user',
        'default',
        1
      )
    `);

    migrateConversationForkLineage(db);
    raw.exec(/*sql*/ `
      UPDATE conversations
      SET fork_parent_conversation_id = 'conv-parent',
          fork_parent_message_id = 'msg-parent'
      WHERE id = 'conv-rerun'
    `);

    expect(() => migrateConversationForkLineage(db)).not.toThrow();

    const row = raw
      .query(
        `SELECT fork_parent_conversation_id, fork_parent_message_id FROM conversations WHERE id = 'conv-rerun'`,
      )
      .get() as {
      fork_parent_conversation_id: string | null;
      fork_parent_message_id: string | null;
    } | null;

    expect(row).toEqual({
      fork_parent_conversation_id: "conv-parent",
      fork_parent_message_id: "msg-parent",
    });
    expect(hasIndex(raw, "idx_conversations_fork_parent_conversation_id")).toBe(
      true,
    );
  });
});
