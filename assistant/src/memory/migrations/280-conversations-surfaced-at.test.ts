import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateConversationsSurfacedAt } from "./280-conversations-surfaced-at.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-280 shape: no surfaced_at column (trimmed to the columns the
  // migration and assertions touch).
  sqlite.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      conversation_type TEXT NOT NULL DEFAULT 'standard',
      archived_at INTEGER
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA table_info(conversations)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

function indexNames(sqlite: Database): string[] {
  return (
    sqlite
      .query(
        "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'conversations'",
      )
      .all() as Array<{ name: string }>
  ).map((i) => i.name);
}

describe("migration 280: conversations surfaced_at", () => {
  test("adds a nullable surfaced_at column and index", () => {
    const { sqlite, db } = createTestDb();
    expect(columnNames(sqlite)).not.toContain("surfaced_at");

    migrateConversationsSurfacedAt(db);

    const column = (
      sqlite.query("PRAGMA table_info(conversations)").all() as Array<{
        name: string;
        notnull: number;
        dflt_value: string | null;
      }>
    ).find((c) => c.name === "surfaced_at");
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
    expect(indexNames(sqlite)).toContain("idx_conversations_surfaced_at");
  });

  test("existing rows read back with surfaced_at null", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO conversations (id, title, created_at, updated_at, conversation_type)
      VALUES ('conv-1', 'Background run', 1000, 1000, 'background')
    `);

    migrateConversationsSurfacedAt(db);

    const row = sqlite
      .query("SELECT surfaced_at FROM conversations WHERE id = 'conv-1'")
      .get() as { surfaced_at: number | null };
    expect(row.surfaced_at).toBeNull();
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateConversationsSurfacedAt(db);
    expect(() => migrateConversationsSurfacedAt(db)).not.toThrow();

    expect(
      columnNames(sqlite).filter((name) => name === "surfaced_at"),
    ).toHaveLength(1);
  });
});
