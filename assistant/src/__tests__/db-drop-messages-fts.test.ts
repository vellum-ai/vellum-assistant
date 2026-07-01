import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../persistence/db-connection.js";
import { createMessagesFts } from "../persistence/migrations/116-messages-fts.js";
import { migrateDropMessagesFts } from "../persistence/migrations/313-drop-messages-fts.js";
import * as schema from "../persistence/schema/index.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrapMessagesTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    CREATE TABLE messages (
      id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      metadata TEXT
    );

    INSERT INTO conversations (id, title, created_at, updated_at)
    VALUES ('conv-1', 'Notes', 1000, 1000);
  `);
}

/**
 * Every `messages_fts`-prefixed entry in sqlite_schema: the vtable, its FTS5
 * shadow tables (_config/_docsize/_content/_idx/_data), and the per-row
 * triggers (_ai/_ad/_au) all share the prefix.
 */
function ftsSchemaObjects(raw: Database): string[] {
  const rows = raw
    .query(
      `SELECT name FROM sqlite_schema WHERE name LIKE 'messages\\_fts%' ESCAPE '\\' ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function insertMessage(raw: Database, id: string, content: string): void {
  raw
    .query(
      `INSERT INTO messages (id, conversation_id, role, content, created_at) VALUES (?, 'conv-1', 'user', ?, 1000)`,
    )
    .run(id, content);
}

describe("migrateDropMessagesFts", () => {
  test("drops the FTS vtable, shadow tables, and per-row triggers", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapMessagesTables(raw);
    createMessagesFts(db);
    insertMessage(raw, "m-1", "the flux capacitor needs recalibration");
    expect(ftsSchemaObjects(raw).length).toBeGreaterThan(0);

    migrateDropMessagesFts(db);

    expect(ftsSchemaObjects(raw)).toEqual([]);
  });

  test("message writes perform no FTS work after the drop", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapMessagesTables(raw);
    createMessagesFts(db);
    insertMessage(raw, "m-1", "indexed before the drop");

    migrateDropMessagesFts(db);

    // Insert, update, and delete must all succeed as plain row operations —
    // a leftover trigger would throw against the missing vtable.
    insertMessage(raw, "m-2", "written after the drop");
    raw
      .query(`UPDATE messages SET content = ? WHERE id = ?`)
      .run("updated after the drop", "m-2");
    raw.query(`DELETE FROM messages WHERE id = ?`).run("m-1");

    const rows = raw
      .query(`SELECT id, content FROM messages ORDER BY id`)
      .all() as Array<{ id: string; content: string }>;
    expect(rows).toEqual([{ id: "m-2", content: "updated after the drop" }]);
  });

  test("is idempotent, including on a database that never had messages_fts", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapMessagesTables(raw);
    createMessagesFts(db);

    migrateDropMessagesFts(db);
    migrateDropMessagesFts(db);
    expect(ftsSchemaObjects(raw)).toEqual([]);

    const fresh = createTestDb();
    bootstrapMessagesTables(getSqliteFrom(fresh));
    migrateDropMessagesFts(fresh);
    expect(ftsSchemaObjects(getSqliteFrom(fresh))).toEqual([]);
  });
});
