import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateCreateDocumentRevisions } from "./385-create-document-revisions.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/*sql*/ `
    PRAGMA foreign_keys = ON;
    CREATE TABLE documents (
      surface_id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      content TEXT NOT NULL
    );
    INSERT INTO documents (surface_id, title, content) VALUES ('doc-1', 'Doc', 'body');
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function insertSnapshot(sqlite: Database, revision: number): void {
  sqlite
    .query(
      /*sql*/ `INSERT INTO document_revisions (surface_id, revision, title, content, author, created_at)
       VALUES ('doc-1', ?, 'Doc', 'body', 'user', 1000)`,
    )
    .run(revision);
}

describe("migration 385: document_revisions", () => {
  test("creates the table keyed by (surface_id, revision)", () => {
    const { sqlite, db } = createTestDb();

    migrateCreateDocumentRevisions(db);

    insertSnapshot(sqlite, 1);
    expect(() => insertSnapshot(sqlite, 1)).toThrow(/UNIQUE/);
  });

  test("cascades from documents", () => {
    const { sqlite, db } = createTestDb();
    migrateCreateDocumentRevisions(db);
    insertSnapshot(sqlite, 1);

    sqlite.run("DELETE FROM documents WHERE surface_id = 'doc-1'");

    const row = sqlite
      .query("SELECT COUNT(*) AS n FROM document_revisions")
      .get() as { n: number };
    expect(row.n).toBe(0);
  });

  test("is idempotent", () => {
    const { sqlite, db } = createTestDb();
    migrateCreateDocumentRevisions(db);
    insertSnapshot(sqlite, 1);

    expect(() => migrateCreateDocumentRevisions(db)).not.toThrow();

    const row = sqlite
      .query("SELECT COUNT(*) AS n FROM document_revisions")
      .get() as { n: number };
    expect(row.n).toBe(1);
  });
});
