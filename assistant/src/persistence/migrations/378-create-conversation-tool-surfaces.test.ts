import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateCreateConversationToolSurfaces } from "./378-create-conversation-tool-surfaces.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.run("PRAGMA foreign_keys = ON");
  // Only the parent table the FK points at.
  sqlite.run(/*sql*/ `CREATE TABLE conversations (id TEXT PRIMARY KEY)`);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function tableDdl(sqlite: Database): string | undefined {
  const row = sqlite
    .query(
      `SELECT sql FROM sqlite_master WHERE type='table' AND name='conversation_tool_surfaces'`,
    )
    .get() as { sql: string } | null;
  return row?.sql;
}

function insertSurface(sqlite: Database, conversationId: string): void {
  sqlite
    .query(
      /*sql*/ `INSERT INTO conversation_tool_surfaces (conversation_id, tools_json, tools_hash, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .run(conversationId, "[]", "hash", 1);
}

function surfaceCount(sqlite: Database): number {
  const row = sqlite
    .query(`SELECT COUNT(*) AS n FROM conversation_tool_surfaces`)
    .get() as { n: number };
  return row.n;
}

describe("migration 378: conversation_tool_surfaces", () => {
  test("creates the table keyed by conversation with a cascading FK", () => {
    const { sqlite, db } = createTestDb();
    expect(tableDdl(sqlite)).toBeUndefined();

    migrateCreateConversationToolSurfaces(db);

    const ddl = tableDdl(sqlite);
    expect(ddl).toContain("conversation_id TEXT PRIMARY KEY");
    expect(ddl).toContain("REFERENCES conversations(id) ON DELETE CASCADE");
    expect(ddl).toContain("tools_json TEXT NOT NULL");
    expect(ddl).toContain("tools_hash TEXT NOT NULL");
    expect(ddl).toContain("updated_at INTEGER NOT NULL");
  });

  test("deleting a conversation cascades to its surface row", () => {
    const { sqlite, db } = createTestDb();
    migrateCreateConversationToolSurfaces(db);
    sqlite.query(`INSERT INTO conversations (id) VALUES (?)`).run("conv-1");
    insertSurface(sqlite, "conv-1");
    expect(surfaceCount(sqlite)).toBe(1);

    sqlite.query(`DELETE FROM conversations WHERE id = ?`).run("conv-1");

    expect(surfaceCount(sqlite)).toBe(0);
  });

  test("is idempotent: a second run keeps the table and its rows", () => {
    const { sqlite, db } = createTestDb();
    migrateCreateConversationToolSurfaces(db);
    sqlite.query(`INSERT INTO conversations (id) VALUES (?)`).run("conv-1");
    insertSurface(sqlite, "conv-1");

    expect(() => migrateCreateConversationToolSurfaces(db)).not.toThrow();

    expect(surfaceCount(sqlite)).toBe(1);
  });
});
