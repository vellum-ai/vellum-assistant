import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateMemoryV3SelectionsMessageIdAndSections } from "./283-memory-v3-selections-message-id-and-sections.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Pre-283 shape: slug/source/pinned only, no message_id or section columns.
  sqlite.exec(/*sql*/ `
    CREATE TABLE memory_v3_selections (
      conversation_id TEXT NOT NULL,
      turn INTEGER NOT NULL,
      slug TEXT NOT NULL,
      source TEXT NOT NULL,
      pinned INTEGER NOT NULL DEFAULT 0,
      created_at INTEGER NOT NULL,
      PRIMARY KEY (conversation_id, turn, slug)
    )
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function columnNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA table_info(memory_v3_selections)").all() as Array<{
      name: string;
    }>
  ).map((c) => c.name);
}

function indexNames(sqlite: Database): string[] {
  return (
    sqlite.query("PRAGMA index_list(memory_v3_selections)").all() as Array<{
      name: string;
    }>
  ).map((i) => i.name);
}

describe("migration 283: memory_v3_selections message_id + section columns", () => {
  test("adds nullable message_id, section_ordinal, section_title + message_id index", () => {
    const { sqlite, db } = createTestDb();
    expect(columnNames(sqlite)).not.toContain("message_id");

    migrateMemoryV3SelectionsMessageIdAndSections(db);

    const cols = sqlite
      .query("PRAGMA table_info(memory_v3_selections)")
      .all() as Array<{ name: string; notnull: number }>;
    for (const name of ["message_id", "section_ordinal", "section_title"]) {
      const col = cols.find((c) => c.name === name);
      expect(col).toBeDefined();
      expect(col?.notnull).toBe(0); // nullable
    }
    expect(indexNames(sqlite)).toContain("idx_memory_v3_selections_message");
  });

  test("existing rows read back with the new columns null", () => {
    const { sqlite, db } = createTestDb();
    sqlite.exec(/*sql*/ `
      INSERT INTO memory_v3_selections
        (conversation_id, turn, slug, source, pinned, created_at)
      VALUES ('conv-1', 0, 'a/page', 'needle', 0, 1000)
    `);

    migrateMemoryV3SelectionsMessageIdAndSections(db);

    const row = sqlite
      .query(
        `SELECT message_id, section_ordinal, section_title
           FROM memory_v3_selections WHERE conversation_id = 'conv-1'`,
      )
      .get() as {
      message_id: string | null;
      section_ordinal: number | null;
      section_title: string | null;
    };
    expect(row.message_id).toBeNull();
    expect(row.section_ordinal).toBeNull();
    expect(row.section_title).toBeNull();
  });

  test("is idempotent — re-run is a no-op", () => {
    const { sqlite, db } = createTestDb();

    migrateMemoryV3SelectionsMessageIdAndSections(db);
    expect(() =>
      migrateMemoryV3SelectionsMessageIdAndSections(db),
    ).not.toThrow();

    expect(columnNames(sqlite).filter((n) => n === "message_id")).toHaveLength(
      1,
    );
    expect(
      indexNames(sqlite).filter(
        (n) => n === "idx_memory_v3_selections_message",
      ),
    ).toHaveLength(1);
  });
});
