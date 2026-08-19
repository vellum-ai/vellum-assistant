import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateCreateWatchTimelineEntries } from "../367-create-watch-timeline-entries.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function columnNames(raw: Database): string[] {
  const rows = raw
    .prepare("PRAGMA table_info(watch_timeline_entries)")
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function indexNames(raw: Database): string[] {
  const rows = raw
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'watch_timeline_entries' AND sql IS NOT NULL ORDER BY name`,
    )
    .all() as Array<{ name: string }>;
  return rows.map((row) => row.name);
}

function insertEntry(raw: Database, id: string, atMs: number): void {
  raw.run(
    `INSERT INTO watch_timeline_entries
       (id, session_id, conversation_id, at_ms, kind, text, ax_tree, ax_diff, screenshot_attachment_id, created_at)
     VALUES (?, 'sess-1', 'conv-1', ?, 'narration', 'hello', NULL, NULL, NULL, 1000)`,
    [id, atMs],
  );
}

describe("migration 367: create watch_timeline_entries", () => {
  test("creates the table with every timeline column", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateCreateWatchTimelineEntries(db);

    expect(columnNames(raw).sort()).toEqual([
      "at_ms",
      "ax_diff",
      "ax_tree",
      "conversation_id",
      "created_at",
      "id",
      "kind",
      "screenshot_attachment_id",
      "session_id",
      "text",
    ]);
  });

  test("creates the session and conversation indexes", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateCreateWatchTimelineEntries(db);

    expect(indexNames(raw)).toEqual([
      "idx_watch_timeline_entries_conversation",
      "idx_watch_timeline_entries_session",
    ]);
  });

  test("is idempotent and preserves existing rows", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateCreateWatchTimelineEntries(db);
    insertEntry(raw, "entry-1", 1000);

    expect(() => migrateCreateWatchTimelineEntries(db)).not.toThrow();

    const rows = raw
      .prepare("SELECT id, at_ms FROM watch_timeline_entries")
      .all() as Array<{ id: string; at_ms: number }>;
    expect(rows).toEqual([{ id: "entry-1", at_ms: 1000 }]);
  });

  test("rejects a duplicate entry id", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateCreateWatchTimelineEntries(db);
    insertEntry(raw, "entry-1", 1000);

    expect(() => insertEntry(raw, "entry-1", 2000)).toThrow();
  });
});
