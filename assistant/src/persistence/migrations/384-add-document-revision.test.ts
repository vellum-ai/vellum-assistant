import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateAddDocumentWorkspacePath } from "./360-add-document-workspace-path.js";
import { migrateAddDocumentRevision } from "./384-add-document-revision.js";

/** Pre-384 shape: the documents table as core tables and migration 360 left it. */
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
    INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at)
      VALUES ('doc-1', 'conv-1', 'Doc', 'body', 1, 1000, 1000);
  `);
  const db = drizzle(sqlite, { schema });
  migrateAddDocumentWorkspacePath(db);
  return { sqlite, db };
}

function revisionColumn(sqlite: Database) {
  return (
    sqlite.query("PRAGMA table_info(documents)").all() as Array<{
      name: string;
      notnull: number;
      dflt_value: string | null;
    }>
  ).find((c) => c.name === "revision");
}

describe("migration 384: documents.revision", () => {
  test("adds a NOT NULL column defaulting to 0", () => {
    const { sqlite, db } = createTestDb();
    expect(revisionColumn(sqlite)).toBeUndefined();

    migrateAddDocumentRevision(db);

    const column = revisionColumn(sqlite);
    expect(column?.notnull).toBe(1);
    expect(column?.dflt_value).toBe("0");
  });

  test("existing rows read revision 0", () => {
    const { sqlite, db } = createTestDb();

    migrateAddDocumentRevision(db);

    const row = sqlite
      .query("SELECT revision FROM documents WHERE surface_id = 'doc-1'")
      .get() as { revision: number };
    expect(row.revision).toBe(0);
  });

  test("is idempotent", () => {
    const { sqlite, db } = createTestDb();

    migrateAddDocumentRevision(db);
    sqlite.run("UPDATE documents SET revision = 3 WHERE surface_id = 'doc-1'");
    expect(() => migrateAddDocumentRevision(db)).not.toThrow();

    const row = sqlite
      .query("SELECT revision FROM documents WHERE surface_id = 'doc-1'")
      .get() as { revision: number };
    expect(row.revision).toBe(3);
  });
});
