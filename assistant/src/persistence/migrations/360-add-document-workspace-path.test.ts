import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateAddDocumentWorkspacePath } from "./360-add-document-workspace-path.js";

/** Pre-360 shape: the documents table exactly as core tables created it. */
function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL
    );

    CREATE TABLE documents (
      surface_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    );

    INSERT INTO conversations (id, created_at) VALUES ('conv-1', 1000);
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnInfo(sqlite: Database) {
  return sqlite.query("PRAGMA table_info(documents)").all() as Array<{
    name: string;
    notnull: number;
  }>;
}

function insertDocument(
  sqlite: Database,
  surfaceId: string,
  workspacePath: string | null,
): void {
  sqlite
    .query(
      /*sql*/ `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at, workspace_path)
       VALUES (?, 'conv-1', 'Doc', '', 0, 1000, 1000, ?)`,
    )
    .run(surfaceId, workspacePath);
}

describe("migration 360: documents.workspace_path", () => {
  test("adds the nullable column to an existing database", () => {
    const { sqlite, db } = createTestDb();
    expect(columnInfo(sqlite).map((c) => c.name)).not.toContain(
      "workspace_path",
    );

    migrateAddDocumentWorkspacePath(db);

    const column = columnInfo(sqlite).find((c) => c.name === "workspace_path");
    expect(column).toBeDefined();
    expect(column?.notnull).toBe(0);
  });

  test("rows written before the column existed read back null", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at)
      VALUES ('doc-old', 'conv-1', 'Old', 'body', 1, 1000, 1000)
    `);

    migrateAddDocumentWorkspacePath(db);

    const row = sqlite
      .query(
        "SELECT workspace_path FROM documents WHERE surface_id = 'doc-old'",
      )
      .get() as { workspace_path: unknown };
    expect(row.workspace_path).toBeNull();
  });

  test("rejects a second document bound to the same file", () => {
    const { sqlite, db } = createTestDb();
    migrateAddDocumentWorkspacePath(db);

    insertDocument(sqlite, "doc-a", "notes/plan.md");

    expect(() => insertDocument(sqlite, "doc-b", "notes/plan.md")).toThrow();
  });

  test("leaves file-less documents unconstrained", () => {
    const { sqlite, db } = createTestDb();
    migrateAddDocumentWorkspacePath(db);

    insertDocument(sqlite, "doc-a", null);
    expect(() => insertDocument(sqlite, "doc-b", null)).not.toThrow();
  });

  test("is idempotent: re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateAddDocumentWorkspacePath(db);
    expect(() => migrateAddDocumentWorkspacePath(db)).not.toThrow();

    const names = columnInfo(sqlite).map((c) => c.name);
    expect(names.filter((n) => n === "workspace_path")).toHaveLength(1);
  });
});
