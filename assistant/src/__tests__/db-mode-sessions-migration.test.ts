import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import {
  downCreateConversationModeSessions,
  migrateCreateConversationModeSessions,
} from "../persistence/migrations/381-create-conversation-mode-sessions.js";
import * as schema from "../persistence/schema.js";

function createPreMigrationDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec(/* sql */ `
    PRAGMA foreign_keys = ON;
    CREATE TABLE conversations (
      id TEXT PRIMARY KEY
    );
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function tableExists(sqlite: Database): boolean {
  return (
    sqlite
      .query(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'conversation_mode_sessions'",
      )
      .get() != null
  );
}

describe("migration 380: conversation mode sessions", () => {
  test("creates the table and indexed conversation lookup", () => {
    const { sqlite, db } = createPreMigrationDb();
    migrateCreateConversationModeSessions(db);

    expect(tableExists(sqlite)).toBe(true);
    const indexes = sqlite
      .query("PRAGMA index_list(conversation_mode_sessions)")
      .all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toContain(
      "idx_conversation_mode_sessions_conversation_status",
    );
  });

  test("is idempotent on an existing migrated database", () => {
    const { sqlite, db } = createPreMigrationDb();
    migrateCreateConversationModeSessions(db);
    expect(() => migrateCreateConversationModeSessions(db)).not.toThrow();

    expect(tableExists(sqlite)).toBe(true);
  });

  test("supports rollback and reapply", () => {
    const { sqlite, db } = createPreMigrationDb();
    migrateCreateConversationModeSessions(db);
    downCreateConversationModeSessions(db);
    expect(tableExists(sqlite)).toBe(false);

    migrateCreateConversationModeSessions(db);
    expect(tableExists(sqlite)).toBe(true);
  });

  test("enforces status values and deletes rows with their conversation", () => {
    const { sqlite, db } = createPreMigrationDb();
    migrateCreateConversationModeSessions(db);
    sqlite.exec(/* sql */ `
      INSERT INTO conversations (id) VALUES ('conv-123');
      INSERT INTO conversation_mode_sessions (
        id, conversation_id, mode, status, source_started_at, last_activity_at
      ) VALUES (
        'session-123', 'conv-123', 'browser', 'active', 100, 100
      );
    `);

    expect(() =>
      sqlite
        .query(
          /* sql */ `
        INSERT INTO conversation_mode_sessions (
          id, conversation_id, mode, status, source_started_at, last_activity_at
        ) VALUES (
          'session-456', 'conv-123', 'browser', 'waiting', 100, 100
        )
      `,
        )
        .run(),
    ).toThrow();

    expect(() =>
      sqlite
        .query(
          /* sql */ `
        INSERT INTO conversation_mode_sessions (
          id, conversation_id, mode, status, source_started_at, last_activity_at,
          ended_at, end_reason
        ) VALUES (
          'session-completed-without-end', 'conv-123', 'browser', 'completed',
          100, 100, NULL, 'settled'
        )
      `,
        )
        .run(),
    ).toThrow();

    expect(() =>
      sqlite
        .query(
          /* sql */ `
        INSERT INTO conversation_mode_sessions (
          id, conversation_id, mode, status, source_started_at, last_activity_at,
          ended_at, end_reason
        ) VALUES (
          'session-empty-reason', 'conv-123', 'browser', 'completed',
          100, 100, 125, ''
        )
      `,
        )
        .run(),
    ).toThrow();

    expect(() =>
      sqlite
        .query(
          /* sql */ `
        INSERT INTO conversation_mode_sessions (
          id, conversation_id, mode, status, source_started_at, last_activity_at,
          ended_at, end_reason
        ) VALUES (
          'session-null-reason', 'conv-123', 'browser', 'completed',
          100, 100, 125, NULL
        )
      `,
        )
        .run(),
    ).toThrow();

    expect(() =>
      sqlite
        .query(
          /* sql */ `
        INSERT INTO conversation_mode_sessions (
          id, conversation_id, mode, status, source_started_at, last_activity_at,
          ended_at, end_reason
        ) VALUES (
          'session-backwards-end', 'conv-123', 'browser', 'interrupted',
          100, 150, 125, 'connection_lost'
        )
      `,
        )
        .run(),
    ).toThrow();

    expect(() =>
      sqlite
        .query(
          /* sql */ `
        INSERT INTO conversation_mode_sessions (
          id, conversation_id, mode, status, source_started_at,
          first_included_at, last_activity_at
        ) VALUES (
          'session-half-boundary', 'conv-123', 'browser', 'active', 100, 110, 110
        )
      `,
        )
        .run(),
    ).toThrow();

    sqlite.exec("DELETE FROM conversations WHERE id = 'conv-123'");
    expect(
      sqlite.query("SELECT id FROM conversation_mode_sessions").all(),
    ).toEqual([]);
  });
});
