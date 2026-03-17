import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { migrateDropCapabilityCardState } from "../memory/migrations/176-drop-capability-card-state.js";
import * as schema from "../memory/schema.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

type TestDb = ReturnType<typeof createTestDb>;

function getRawSqlite(db: TestDb): Database {
  return (db as unknown as { $client: Database }).$client;
}

function createLegacyCapabilityCardTables(raw: Database) {
  raw.exec(/*sql*/ `
    CREATE TABLE memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  raw.exec(/*sql*/ `
    CREATE TABLE memory_jobs (
      id TEXT PRIMARY KEY,
      type TEXT NOT NULL,
      payload TEXT NOT NULL,
      status TEXT NOT NULL,
      attempts INTEGER NOT NULL DEFAULT 0,
      deferrals INTEGER NOT NULL DEFAULT 0,
      run_after INTEGER NOT NULL,
      last_error TEXT,
      started_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  raw.exec(/*sql*/ `
    CREATE TABLE conversation_starters (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      prompt TEXT NOT NULL,
      generation_batch INTEGER NOT NULL,
      scope_id TEXT NOT NULL DEFAULT 'default',
      card_type TEXT NOT NULL DEFAULT 'chip',
      created_at INTEGER NOT NULL
    )
  `);

  raw.exec(/*sql*/ `
    CREATE TABLE capability_card_categories (
      scope_id TEXT NOT NULL,
      category TEXT NOT NULL,
      relevance REAL NOT NULL,
      generation_batch INTEGER NOT NULL,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (scope_id, category)
    )
  `);
}

describe("migrateDropCapabilityCardState", () => {
  test("removes legacy capability-card rows, jobs, checkpoints, and table", () => {
    const db = createTestDb();
    const raw = getRawSqlite(db);
    const now = Date.now();

    createLegacyCapabilityCardTables(raw);

    raw.exec(/*sql*/ `
      INSERT INTO conversation_starters (id, label, prompt, generation_batch, scope_id, card_type, created_at)
      VALUES
        ('chip-1', 'Prep tomorrow', 'Prep tomorrow', 1, 'default', 'chip', ${now}),
        ('card-1', 'Do this first', 'Do this first', 1, 'default', 'card', ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO memory_jobs (id, type, payload, status, attempts, deferrals, run_after, created_at, updated_at)
      VALUES
        ('job-chip', 'generate_conversation_starters', '{}', 'pending', 0, 0, ${now}, ${now}, ${now}),
        ('job-card', 'generate_capability_cards', '{}', 'pending', 0, 0, ${now}, ${now}, ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO memory_checkpoints (key, value, updated_at)
      VALUES
        ('capability_cards:generation_batch', '7', ${now}),
        ('other_checkpoint', '1', ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO capability_card_categories (scope_id, category, relevance, generation_batch, created_at)
      VALUES ('default', 'communication', 0.9, 1, ${now})
    `);

    migrateDropCapabilityCardState(db);

    const starterRows = raw
      .query(`SELECT id, card_type FROM conversation_starters ORDER BY id`)
      .all() as Array<{ id: string; card_type: string }>;
    expect(starterRows).toEqual([{ id: "chip-1", card_type: "chip" }]);

    const jobTypes = raw
      .query(`SELECT type FROM memory_jobs ORDER BY id`)
      .all() as Array<{
      type: string;
    }>;
    expect(jobTypes).toEqual([{ type: "generate_conversation_starters" }]);

    const checkpointKeys = raw
      .query(`SELECT key FROM memory_checkpoints ORDER BY key`)
      .all() as Array<{ key: string }>;
    expect(checkpointKeys.map((row) => row.key)).toEqual([
      "migration_drop_capability_card_state_v1",
      "other_checkpoint",
    ]);

    const migrationCheckpoint = raw
      .query(
        `SELECT value FROM memory_checkpoints WHERE key = 'migration_drop_capability_card_state_v1'`,
      )
      .get() as { value: string } | null;
    expect(migrationCheckpoint?.value).toBe("1");

    const legacyTable = raw
      .query(
        `SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'capability_card_categories'`,
      )
      .get();
    expect(legacyTable).toBeNull();
  });

  test("is idempotent when run more than once", () => {
    const db = createTestDb();
    const raw = getRawSqlite(db);
    const now = Date.now();

    createLegacyCapabilityCardTables(raw);
    raw.exec(/*sql*/ `
      INSERT INTO conversation_starters (id, label, prompt, generation_batch, scope_id, card_type, created_at)
      VALUES ('card-1', 'Do this first', 'Do this first', 1, 'default', 'card', ${now})
    `);
    raw.exec(/*sql*/ `
      INSERT INTO memory_jobs (id, type, payload, status, attempts, deferrals, run_after, created_at, updated_at)
      VALUES ('job-card', 'generate_capability_cards', '{}', 'pending', 0, 0, ${now}, ${now}, ${now})
    `);

    migrateDropCapabilityCardState(db);
    migrateDropCapabilityCardState(db);

    const starterCount = raw
      .query(`SELECT COUNT(*) AS count FROM conversation_starters`)
      .get() as { count: number };
    expect(starterCount.count).toBe(0);

    const jobCount = raw
      .query(
        `SELECT COUNT(*) AS count FROM memory_jobs WHERE type = 'generate_capability_cards'`,
      )
      .get() as { count: number };
    expect(jobCount.count).toBe(0);
  });
});
