import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateAddConversationParentId } from "./342-add-conversation-parent-id.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-342 shape: only the columns the migration and tests touch. The
  // `subagents` table (migration 311) always precedes 342 in the step order
  // and is the backfill source.
  sqlite.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );
    CREATE TABLE subagents (
      id TEXT PRIMARY KEY,
      parent_conversation_id TEXT NOT NULL,
      conversation_id TEXT NOT NULL
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function parentOf(sqlite: Database, conversationId: string): unknown {
  const row = sqlite
    .query("SELECT parent_conversation_id FROM conversations WHERE id = ?")
    .get(conversationId) as { parent_conversation_id: unknown };
  return row.parent_conversation_id;
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

    expect(parentOf(sqlite, "conv-1")).toBeNull();
  });

  test("round-trips an insert that sets the new column", () => {
    const { sqlite, db } = createTestDb();
    migrateAddConversationParentId(db);

    sqlite.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at, parent_conversation_id)
      VALUES ('child-1', 2000, 2000, 'parent-1')
    `);

    expect(parentOf(sqlite, "child-1")).toBe("parent-1");
  });

  test("backfills parent ids from surviving subagents rows", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at) VALUES
        ('sub-conv-1', 1000, 1000),
        ('sub-conv-2', 2000, 2000),
        ('plain-conv', 3000, 3000);
      INSERT INTO subagents (id, parent_conversation_id, conversation_id) VALUES
        ('s1', 'parent-a', 'sub-conv-1'),
        ('s2', 'parent-b', 'sub-conv-2');
    `);

    migrateAddConversationParentId(db);

    expect(parentOf(sqlite, "sub-conv-1")).toBe("parent-a");
    expect(parentOf(sqlite, "sub-conv-2")).toBe("parent-b");
    // Conversations with no surviving subagents row stay parentless.
    expect(parentOf(sqlite, "plain-conv")).toBeNull();
  });

  test("backfill does not overwrite an already-set parent id", () => {
    const { sqlite, db } = createTestDb();
    migrateAddConversationParentId(db);
    sqlite.exec(/*sql*/ `
      INSERT INTO conversations (id, created_at, updated_at, parent_conversation_id)
      VALUES ('stamped', 1000, 1000, 'parent-live');
      INSERT INTO subagents (id, parent_conversation_id, conversation_id)
      VALUES ('s1', 'parent-stale', 'stamped');
    `);

    migrateAddConversationParentId(db);

    expect(parentOf(sqlite, "stamped")).toBe("parent-live");
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
