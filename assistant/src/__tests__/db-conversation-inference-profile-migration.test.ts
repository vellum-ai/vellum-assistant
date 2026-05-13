import { rmSync } from "node:fs";
import { Database } from "bun:sqlite";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { makeMockLogger } from "./helpers/mock-logger.js";

const originalBunTest = process.env.BUN_TEST;

mock.module("../util/logger.js", () => ({
  getLogger: () => makeMockLogger(),
}));

import { _resetDisplayOrderMigrationForTests } from "../memory/conversation-display-order-migration.js";
import { _resetGroupMigrationForTests } from "../memory/conversation-group-migration.js";
import { resetDb } from "../memory/db-connection.js";
import { getSqliteFrom } from "../memory/db-connection.js";
import { initializeDb } from "../memory/db-init.js";
import { migrateAddConversationInferenceProfile } from "../memory/migrations/227-add-conversation-inference-profile.js";
import { migrateRenameInferenceProfileSnakeCase } from "../memory/migrations/228-rename-inference-profile-snake-case.js";
import * as schema from "../memory/schema.js";
import { getDbPath } from "../util/platform.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function getColumnNames(raw: Database): string[] {
  return (
    raw.query(`PRAGMA table_info(conversations)`).all() as Array<{
      name: string;
    }>
  ).map((column) => column.name);
}

function bootstrapPreInferenceProfileConversations(raw: Database): void {
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
      host_access INTEGER NOT NULL DEFAULT 0,
      is_auto_title INTEGER NOT NULL DEFAULT 1,
      schedule_job_id TEXT,
      last_message_at INTEGER,
      archived_at INTEGER
    )
  `);
}

function removeTestDbFiles(): void {
  resetDb();
  // Reset the in-process guards for the lazy `group_id` / `display_order` /
  // `is_pinned` migrations so the freshly recreated DB gets those columns
  // again. Otherwise downstream tests hit `no such column: group_id`.
  _resetGroupMigrationForTests();
  _resetDisplayOrderMigrationForTests();
  const dbPath = getDbPath();
  rmSync(dbPath, { force: true });
  rmSync(`${dbPath}-shm`, { force: true });
  rmSync(`${dbPath}-wal`, { force: true });
}

describe("conversation inference profile migration", () => {
  beforeEach(() => {
    process.env.BUN_TEST = "0";
    removeTestDbFiles();
  });

  afterAll(() => {
    process.env.BUN_TEST = originalBunTest;
    removeTestDbFiles();
  });

  test("fresh DB initialization includes nullable inference_profile column", () => {
    initializeDb();

    const raw = new Database(getDbPath());
    const columns = getColumnNames(raw);
    // Migration 228 renames the camelCase column added by 227 to snake_case to
    // match the rest of the table.
    expect(columns).toContain("inference_profile");
    expect(columns).not.toContain("inferenceProfile");

    const inferenceProfileColumn = (
      raw.query(`PRAGMA table_info(conversations)`).all() as Array<{
        name: string;
        notnull: number;
      }>
    ).find((column) => column.name === "inference_profile");

    expect(inferenceProfileColumn).toBeDefined();
    expect(inferenceProfileColumn?.notnull).toBe(0);
    raw.close();
  });

  test("migration upgrades the previous schema without disturbing existing rows", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPreInferenceProfileConversations(raw);
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
        'conv-existing',
        'Existing conversation',
        ${now},
        ${now},
        'standard',
        'user',
        'default',
        1
      )
    `);

    migrateAddConversationInferenceProfile(db);

    expect(getColumnNames(raw)).toContain("inferenceProfile");

    const row = raw
      .query(
        `SELECT id, title, inferenceProfile FROM conversations WHERE id = 'conv-existing'`,
      )
      .get() as {
      id: string;
      title: string | null;
      inferenceProfile: string | null;
    } | null;

    expect(row).toEqual({
      id: "conv-existing",
      title: "Existing conversation",
      inferenceProfile: null,
    });
  });

  test("re-running the migration is a no-op and preserves stored values", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPreInferenceProfileConversations(raw);
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
        'Conversation with override',
        ${now},
        ${now},
        'standard',
        'user',
        'default',
        1
      )
    `);

    migrateAddConversationInferenceProfile(db);
    raw.exec(/*sql*/ `
      UPDATE conversations
      SET inferenceProfile = 'quality-optimized'
      WHERE id = 'conv-rerun'
    `);

    expect(() => migrateAddConversationInferenceProfile(db)).not.toThrow();

    const row = raw
      .query(
        `SELECT inferenceProfile FROM conversations WHERE id = 'conv-rerun'`,
      )
      .get() as {
      inferenceProfile: string | null;
    } | null;

    expect(row).toEqual({ inferenceProfile: "quality-optimized" });
  });

  test("replaying 227 + 228 across multiple boots does not re-add the camelCase column", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPreInferenceProfileConversations(raw);

    // First boot: 227 adds camelCase, 228 renames to snake_case.
    migrateAddConversationInferenceProfile(db);
    migrateRenameInferenceProfileSnakeCase(db);
    expect(getColumnNames(raw)).toContain("inference_profile");
    expect(getColumnNames(raw)).not.toContain("inferenceProfile");

    // Second boot: replays must not re-add the camelCase column.
    migrateAddConversationInferenceProfile(db);
    migrateRenameInferenceProfileSnakeCase(db);
    expect(getColumnNames(raw)).toContain("inference_profile");
    expect(getColumnNames(raw)).not.toContain("inferenceProfile");
  });

  test("228 self-heals when both columns are present from the legacy bug", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    bootstrapPreInferenceProfileConversations(raw);
    // Simulate the legacy state: both columns exist because 227 re-added the
    // camelCase column on a boot after 228 had already renamed it.
    raw.exec(`ALTER TABLE conversations ADD COLUMN inference_profile TEXT`);
    raw.exec(`ALTER TABLE conversations ADD COLUMN inferenceProfile TEXT`);
    expect(getColumnNames(raw)).toContain("inferenceProfile");

    migrateRenameInferenceProfileSnakeCase(db);

    expect(getColumnNames(raw)).toContain("inference_profile");
    expect(getColumnNames(raw)).not.toContain("inferenceProfile");
  });

  test("new rows default to NULL inferenceProfile after migration", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    const now = Date.now();

    bootstrapPreInferenceProfileConversations(raw);
    migrateAddConversationInferenceProfile(db);
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
        'conv-new',
        'New conversation',
        ${now},
        ${now},
        'standard',
        'user',
        'default',
        1
      )
    `);

    const row = raw
      .query(`SELECT inferenceProfile FROM conversations WHERE id = 'conv-new'`)
      .get() as {
      inferenceProfile: string | null;
    } | null;

    expect(row).toEqual({ inferenceProfile: null });
  });
});
