import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../memory/db-connection.js";
import { migrateCreateDocumentConversations } from "../memory/migrations/233-document-conversations.js";
import * as schema from "../memory/schema.js";

interface TableRow {
  name: string;
}

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}

interface JunctionRow {
  surface_id: string;
  conversation_id: string;
  created_at: number;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrapCheckpointsTable(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS memory_checkpoints (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

function bootstrapConversationsTable(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      created_at INTEGER NOT NULL DEFAULT (strftime('%s','now') * 1000)
    )
  `);
}

function bootstrapDocumentsTable(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE IF NOT EXISTS documents (
      surface_id TEXT PRIMARY KEY,
      conversation_id TEXT NOT NULL REFERENCES conversations(id) ON DELETE CASCADE,
      title TEXT NOT NULL,
      content TEXT NOT NULL,
      word_count INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

/** Full bootstrap: checkpoints + conversations + documents (prereqs for the migration). */
function bootstrapAll(raw: Database): void {
  bootstrapCheckpointsTable(raw);
  bootstrapConversationsTable(raw);
  bootstrapDocumentsTable(raw);
}

describe("document_conversations migration", () => {
  test("creates table with expected columns, composite PK, and index", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapAll(raw);

    migrateCreateDocumentConversations(db);

    const tableRow = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name='document_conversations'`,
      )
      .get() as TableRow | null;
    expect(tableRow?.name).toBe("document_conversations");

    const columns = raw
      .query(`PRAGMA table_info(document_conversations)`)
      .all() as ColumnRow[];

    const byName = new Map(columns.map((c) => [c.name, c]));
    expect(byName.get("surface_id")?.type).toBe("TEXT");
    expect(byName.get("surface_id")?.notnull).toBe(1);
    expect(byName.get("surface_id")?.pk).toBe(1);
    expect(byName.get("conversation_id")?.type).toBe("TEXT");
    expect(byName.get("conversation_id")?.notnull).toBe(1);
    expect(byName.get("conversation_id")?.pk).toBe(2);
    expect(byName.get("created_at")?.type).toBe("INTEGER");
    expect(byName.get("created_at")?.notnull).toBe(1);

    // Verify index on conversation_id
    const indexRow = raw
      .query(
        `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_doc_conv_conversation_id'`,
      )
      .get() as TableRow | null;
    expect(indexRow?.name).toBe("idx_doc_conv_conversation_id");
  });

  test("backfills from existing documents.conversation_id", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapAll(raw);

    // Seed a conversation and a document before running the migration
    raw
      .query(`INSERT INTO conversations (id, created_at) VALUES (?, ?)`)
      .run("conv-1", 1000);
    raw
      .query(
        `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("doc-1", "conv-1", "Test Doc", "content", 2, 1000, 1000);

    migrateCreateDocumentConversations(db);

    const rows = raw
      .query(
        `SELECT surface_id, conversation_id, created_at FROM document_conversations`,
      )
      .all() as JunctionRow[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.surface_id).toBe("doc-1");
    expect(rows[0]!.conversation_id).toBe("conv-1");
    expect(rows[0]!.created_at).toBe(1000);
  });

  test("saving a document populates the junction table", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapAll(raw);
    migrateCreateDocumentConversations(db);

    // Insert a conversation + document + junction row manually (simulating saveDocument)
    raw
      .query(`INSERT INTO conversations (id, created_at) VALUES (?, ?)`)
      .run("conv-a", 2000);
    raw
      .query(
        `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("doc-a", "conv-a", "Title A", "body", 1, 2000, 2000);
    raw
      .query(
        `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
      )
      .run("doc-a", "conv-a", 2000);

    const rows = raw
      .query(
        `SELECT surface_id, conversation_id FROM document_conversations WHERE surface_id = ?`,
      )
      .all("doc-a") as JunctionRow[];

    expect(rows).toHaveLength(1);
    expect(rows[0]!.conversation_id).toBe("conv-a");
  });

  test("saving the same document from a second conversation adds a second row", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapAll(raw);
    migrateCreateDocumentConversations(db);

    raw
      .query(`INSERT INTO conversations (id, created_at) VALUES (?, ?)`)
      .run("conv-a", 2000);
    raw
      .query(
        `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("doc-a", "conv-a", "Title A", "body", 1, 2000, 2000);
    raw
      .query(
        `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
      )
      .run("doc-a", "conv-a", 2000);

    // Associate with a second conversation (no FK to conversations, so conv-b need not exist)
    raw
      .query(
        `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
      )
      .run("doc-a", "conv-b", 3000);

    const rows = raw
      .query(
        `SELECT surface_id, conversation_id FROM document_conversations WHERE surface_id = ? ORDER BY conversation_id`,
      )
      .all("doc-a") as JunctionRow[];

    expect(rows).toHaveLength(2);
    expect(rows[0]!.conversation_id).toBe("conv-a");
    expect(rows[1]!.conversation_id).toBe("conv-b");
  });

  test("listDocuments with conversationId returns matched conversation_id via junction", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapAll(raw);
    migrateCreateDocumentConversations(db);

    raw
      .query(`INSERT INTO conversations (id, created_at) VALUES (?, ?)`)
      .run("conv-origin", 1000);
    raw
      .query(
        `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("doc-x", "conv-origin", "My Doc", "content here", 2, 1000, 1000);

    // Associate with conv-origin AND conv-viewer
    raw
      .query(
        `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
      )
      .run("doc-x", "conv-origin", 1000);
    raw
      .query(
        `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
      )
      .run("doc-x", "conv-viewer", 2000);

    // Query via junction for conv-viewer — should return conv-viewer as conversation_id
    const results = raw
      .query(
        /*sql*/ `
        SELECT d.surface_id, dc.conversation_id AS conversation_id,
               d.title, d.word_count, d.created_at, d.updated_at
        FROM documents d
        INNER JOIN document_conversations dc ON d.surface_id = dc.surface_id
        WHERE dc.conversation_id = ?
        ORDER BY d.updated_at DESC
      `,
      )
      .all("conv-viewer") as {
      surface_id: string;
      conversation_id: string;
      title: string;
    }[];

    expect(results).toHaveLength(1);
    expect(results[0]!.surface_id).toBe("doc-x");
    expect(results[0]!.conversation_id).toBe("conv-viewer"); // matched, not origin
    expect(results[0]!.title).toBe("My Doc");
  });

  test("CASCADE: deleting a document removes junction entries", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapAll(raw);
    migrateCreateDocumentConversations(db);

    raw
      .query(`INSERT INTO conversations (id, created_at) VALUES (?, ?)`)
      .run("conv-c", 1000);
    raw
      .query(
        `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("doc-del", "conv-c", "To Delete", "bye", 1, 1000, 1000);
    raw
      .query(
        `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
      )
      .run("doc-del", "conv-c", 1000);
    raw
      .query(
        `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
      )
      .run("doc-del", "conv-d", 2000);

    // Verify junction rows exist
    let junctionRows = raw
      .query(`SELECT * FROM document_conversations WHERE surface_id = ?`)
      .all("doc-del") as JunctionRow[];
    expect(junctionRows).toHaveLength(2);

    // Delete the document — should cascade to junction table
    raw.query(`DELETE FROM documents WHERE surface_id = ?`).run("doc-del");

    junctionRows = raw
      .query(`SELECT * FROM document_conversations WHERE surface_id = ?`)
      .all("doc-del") as JunctionRow[];
    expect(junctionRows).toHaveLength(0);
  });

  test("re-running the migration is idempotent", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapAll(raw);

    migrateCreateDocumentConversations(db);

    // Insert data
    raw
      .query(`INSERT INTO conversations (id, created_at) VALUES (?, ?)`)
      .run("conv-idem", 1000);
    raw
      .query(
        `INSERT INTO documents (surface_id, conversation_id, title, content, word_count, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      )
      .run("doc-idem", "conv-idem", "Title", "body", 1, 1000, 1000);
    raw
      .query(
        `INSERT OR IGNORE INTO document_conversations (surface_id, conversation_id, created_at) VALUES (?, ?, ?)`,
      )
      .run("doc-idem", "conv-idem", 1000);

    // Re-run should not throw or duplicate data
    expect(() => migrateCreateDocumentConversations(db)).not.toThrow();

    const rows = raw
      .query(`SELECT * FROM document_conversations WHERE surface_id = ?`)
      .all("doc-idem") as JunctionRow[];
    expect(rows).toHaveLength(1);
  });
});
