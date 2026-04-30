import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../memory/db-connection.js";
import {
  downSlackCompactionWatermark,
  migrateSlackCompactionWatermark,
} from "../memory/migrations/235-slack-compaction-watermark.js";
import * as schema from "../memory/schema.js";

interface ColumnRow {
  name: string;
  type: string;
  notnull: number;
}

interface ConversationCompactionRow {
  id: string;
  context_summary: string | null;
  context_compacted_message_count: number;
  context_compacted_at: number | null;
  slack_context_compaction_watermark_ts: string | null;
  slack_context_compaction_watermark_at: number | null;
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

function bootstrapLegacyConversations(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY,
      title TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      context_summary TEXT,
      context_compacted_message_count INTEGER NOT NULL DEFAULT 0,
      context_compacted_at INTEGER
    )
  `);
}

function getConversationColumns(raw: Database): Map<string, ColumnRow> {
  const columns = raw
    .query(`PRAGMA table_info(conversations)`)
    .all() as ColumnRow[];
  return new Map(columns.map((column) => [column.name, column]));
}

describe("migrateSlackCompactionWatermark", () => {
  test("adds nullable Slack watermark columns and preserves existing compaction state", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    bootstrapLegacyConversations(raw);

    raw
      .query(
        /*sql*/ `
          INSERT INTO conversations (
            id,
            title,
            created_at,
            updated_at,
            context_summary,
            context_compacted_message_count,
            context_compacted_at
          ) VALUES (?, ?, ?, ?, ?, ?, ?)
        `,
      )
      .run(
        "conv-1",
        "legacy slack thread",
        1000,
        2000,
        "existing compacted summary",
        42,
        3000,
      );

    migrateSlackCompactionWatermark(db);

    const columns = getConversationColumns(raw);
    expect(columns.get("slack_context_compaction_watermark_ts")).toMatchObject({
      type: "TEXT",
      notnull: 0,
    });
    expect(columns.get("slack_context_compaction_watermark_at")).toMatchObject({
      type: "INTEGER",
      notnull: 0,
    });

    const row = raw
      .query(
        /*sql*/ `
          SELECT
            id,
            context_summary,
            context_compacted_message_count,
            context_compacted_at,
            slack_context_compaction_watermark_ts,
            slack_context_compaction_watermark_at
          FROM conversations
          WHERE id = ?
        `,
      )
      .get("conv-1") as ConversationCompactionRow | null;

    expect(row).toEqual({
      id: "conv-1",
      context_summary: "existing compacted summary",
      context_compacted_message_count: 42,
      context_compacted_at: 3000,
      slack_context_compaction_watermark_ts: null,
      slack_context_compaction_watermark_at: null,
    });
  });

  test("is idempotent when columns already exist", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    bootstrapLegacyConversations(raw);
    raw.exec(
      `ALTER TABLE conversations ADD COLUMN slack_context_compaction_watermark_ts TEXT`,
    );
    raw.exec(
      `ALTER TABLE conversations ADD COLUMN slack_context_compaction_watermark_at INTEGER`,
    );

    expect(() => migrateSlackCompactionWatermark(db)).not.toThrow();

    const columns = getConversationColumns(raw);
    expect(columns.has("slack_context_compaction_watermark_ts")).toBe(true);
    expect(columns.has("slack_context_compaction_watermark_at")).toBe(true);
  });

  test("down migration drops Slack watermark columns and is idempotent", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapCheckpointsTable(raw);
    bootstrapLegacyConversations(raw);

    migrateSlackCompactionWatermark(db);

    downSlackCompactionWatermark(db);
    expect(() => downSlackCompactionWatermark(db)).not.toThrow();

    const columns = getConversationColumns(raw);
    expect(columns.has("slack_context_compaction_watermark_ts")).toBe(false);
    expect(columns.has("slack_context_compaction_watermark_at")).toBe(false);
  });
});
