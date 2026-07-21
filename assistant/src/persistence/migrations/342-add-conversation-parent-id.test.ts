import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateAddConversationParentId } from "./342-add-conversation-parent-id.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-342 shape: only the columns the migration and tests touch.
  sqlite.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnInfo(sqlite: Database) {
  return sqlite.query("PRAGMA table_info(conversations)").all() as Array<{
    name: string;
    notnull: number;
  }>;
}

function indexNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA index_list(conversations)").all() as Array<{
      name: string;
    }>
  ).map((i) => i.name);
}

describe("migration 342: conversations.parent_conversation_id", () => {
  test("adds the nullable column and its index", () => {
    const { sqlite, db } = createTestDb();
    expect(columnInfo(sqlite).map((c) => c.name)).not.toContain(
      "parent_conversation_id",
    );

    migrateAddConversationParentId(db);

    const column = columnInfo(sqlite).find(
      (c) => c.name === "parent_conversation_id",
    );
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
    expect(indexNames(sqlite)).toContain(
      "idx_conversations_parent_conversation_id",
    );
  });

  test("existing rows read back with null parent_conversation_id", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at)
      VALUES ('conv-1', 1000, 1000)
    `);

    migrateAddConversationParentId(db);

    const row = sqlite
      .query(
        "SELECT parent_conversation_id FROM conversations WHERE id = 'conv-1'",
      )
      .get() as { parent_conversation_id: unknown };
    expect(row.parent_conversation_id).toBeNull();
  });

  test("round-trips an insert that sets the new column", () => {
    const { sqlite, db } = createTestDb();
    migrateAddConversationParentId(db);

    sqlite.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at, parent_conversation_id)
      VALUES ('child-1', 2000, 2000, 'parent-1')
    `);

    const row = sqlite
      .query(
        "SELECT parent_conversation_id FROM conversations WHERE id = 'child-1'",
      )
      .get() as { parent_conversation_id: unknown };
    expect(row.parent_conversation_id).toBe("parent-1");
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateAddConversationParentId(db);
    expect(() => migrateAddConversationParentId(db)).not.toThrow();

    const names = columnInfo(sqlite).map((c) => c.name);
    expect(
      names.filter((n) => n === "parent_conversation_id"),
    ).toHaveLength(1);
  });
});
