import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateLlmUsageEventsAddAssistantVersion } from "../267-llm-usage-events-add-assistant-version.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

/**
 * Inline minimal CREATE TABLE for just `llm_usage_events`. We deliberately
 * don't call migration 101 — it also sets up FTS triggers + other tables
 * that aren't relevant here and pull in more surface area than we need to
 * validate this migration.
 *
 * Schema mirrors the post-251 (llm_usage_events incl. inference profile)
 * state on purpose so the test reflects what the migration runs against
 * in prod.
 */
function bootstrap(db: ReturnType<typeof createTestDb>): void {
  db.run(/*sql*/ `
    CREATE TABLE llm_usage_events (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL,
      provider TEXT NOT NULL,
      model TEXT NOT NULL,
      input_tokens INTEGER NOT NULL,
      output_tokens INTEGER NOT NULL
    )
  `);
}

describe("migration 267 — llm_usage_events add assistant_version", () => {
  test("adds nullable assistant_version TEXT to llm_usage_events", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    const before = raw
      .query(`PRAGMA table_info(llm_usage_events)`)
      .all() as ColumnRow[];
    expect(before.map((c) => c.name)).not.toContain("assistant_version");

    migrateLlmUsageEventsAddAssistantVersion(db);

    const after = raw
      .query(`PRAGMA table_info(llm_usage_events)`)
      .all() as ColumnRow[];
    const col = after.find((c) => c.name === "assistant_version");
    expect(col).toBeDefined();
    expect(col!.type).toBe("TEXT");
    // Nullable, no default — pre-migration rows stay NULL.
    expect(col!.notnull).toBe(0);
    expect(col!.dflt_value).toBeNull();
  });

  test("is idempotent — running twice does not throw", () => {
    const db = createTestDb();
    bootstrap(db);
    migrateLlmUsageEventsAddAssistantVersion(db);
    expect(() => migrateLlmUsageEventsAddAssistantVersion(db)).not.toThrow();
  });

  test("pre-migration rows survive with assistant_version = NULL", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    raw.run(`
      INSERT INTO llm_usage_events
        (id, created_at, provider, model, input_tokens, output_tokens)
      VALUES
        ('u1', 1, 'anthropic', 'claude-sonnet-4', 10, 20)
    `);

    migrateLlmUsageEventsAddAssistantVersion(db);

    const usage = raw
      .query(`SELECT id, assistant_version FROM llm_usage_events`)
      .all() as Array<{ id: string; assistant_version: string | null }>;
    expect(usage).toEqual([{ id: "u1", assistant_version: null }]);
  });

  test("post-migration rows can be inserted with assistant_version", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);
    migrateLlmUsageEventsAddAssistantVersion(db);

    raw.run(`
      INSERT INTO llm_usage_events
        (id, created_at, provider, model, input_tokens, output_tokens,
         assistant_version)
      VALUES
        ('u2', 4, 'anthropic', 'claude-sonnet-4', 10, 20, '0.8.4')
    `);
    const row = raw
      .query(`SELECT assistant_version FROM llm_usage_events WHERE id = 'u2'`)
      .get() as { assistant_version: string };
    expect(row.assistant_version).toBe("0.8.4");
  });
});
