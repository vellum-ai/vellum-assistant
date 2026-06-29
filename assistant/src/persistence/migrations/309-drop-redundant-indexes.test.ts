import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import * as schema from "../schema.js";
import { migrateDropRedundantIndexes } from "./309-drop-redundant-indexes.js";

// The nine redundant indexes this migration drops.
const DROPPED = [
  "idx_messages_conversation_id",
  "idx_trace_events_conversation_id",
  "idx_notification_deliveries_decision_id",
  "idx_ext_conv_bindings_channel",
  "idx_ext_conv_bindings_channel_chat",
  "idx_followups_channel",
  "idx_followups_status",
  "idx_guardian_action_requests_call_session",
  "idx_media_keyframes_asset_id",
];

// The wider indexes that subsume them — must survive the migration.
const KEPT = [
  "idx_messages_conversation_created_at",
  "idx_trace_events_conversation_timestamp",
  "idx_notification_deliveries_unique",
  "idx_ext_conv_bindings_channel_chat_thread",
  "idx_followups_channel_thread",
  "idx_followups_status_expected",
  "idx_guardian_action_requests_session_status_created",
  "idx_media_keyframes_asset_timestamp",
];

function createTestDb() {
  const sqlite = new Database(":memory:");
  // Minimal tables carrying just the columns the indexes reference, then every
  // index (redundant + subsuming) created up front so the migration has
  // something to drop and something to leave alone.
  sqlite.exec(/*sql*/ `
    CREATE TABLE messages (id TEXT PRIMARY KEY, conversation_id TEXT, created_at INTEGER);
    CREATE INDEX idx_messages_conversation_id ON messages(conversation_id);
    CREATE INDEX idx_messages_conversation_created_at ON messages(conversation_id, created_at);

    CREATE TABLE trace_events (event_id TEXT PRIMARY KEY, conversation_id TEXT, timestamp_ms INTEGER);
    CREATE INDEX idx_trace_events_conversation_id ON trace_events(conversation_id);
    CREATE INDEX idx_trace_events_conversation_timestamp ON trace_events(conversation_id, timestamp_ms);

    CREATE TABLE notification_deliveries (id TEXT PRIMARY KEY, notification_decision_id TEXT, channel TEXT, destination TEXT, attempt INTEGER);
    CREATE INDEX idx_notification_deliveries_decision_id ON notification_deliveries(notification_decision_id);
    CREATE UNIQUE INDEX idx_notification_deliveries_unique ON notification_deliveries(notification_decision_id, channel, destination, attempt);

    CREATE TABLE external_conversation_bindings (id TEXT PRIMARY KEY, source_channel TEXT, external_chat_id TEXT, external_thread_id TEXT);
    CREATE INDEX idx_ext_conv_bindings_channel ON external_conversation_bindings(source_channel);
    CREATE INDEX idx_ext_conv_bindings_channel_chat ON external_conversation_bindings(source_channel, external_chat_id);
    CREATE INDEX idx_ext_conv_bindings_channel_chat_thread ON external_conversation_bindings(source_channel, external_chat_id, external_thread_id);

    CREATE TABLE followups (id TEXT PRIMARY KEY, channel TEXT, conversation_id TEXT, status TEXT, expected_response_by INTEGER);
    CREATE INDEX idx_followups_channel ON followups(channel);
    CREATE INDEX idx_followups_channel_thread ON followups(channel, conversation_id);
    CREATE INDEX idx_followups_status ON followups(status);
    CREATE INDEX idx_followups_status_expected ON followups(status, expected_response_by);

    CREATE TABLE guardian_action_requests (id TEXT PRIMARY KEY, call_session_id TEXT, status TEXT, created_at INTEGER);
    CREATE INDEX idx_guardian_action_requests_call_session ON guardian_action_requests(call_session_id);
    CREATE INDEX idx_guardian_action_requests_session_status_created ON guardian_action_requests(call_session_id, status, created_at);

    CREATE TABLE media_keyframes (id TEXT PRIMARY KEY, asset_id TEXT, timestamp INTEGER);
    CREATE INDEX idx_media_keyframes_asset_id ON media_keyframes(asset_id);
    CREATE INDEX idx_media_keyframes_asset_timestamp ON media_keyframes(asset_id, timestamp);
  `);
  return { sqlite, db: drizzle(sqlite, { schema }) };
}

function indexExists(sqlite: Database, name: string): boolean {
  return !!sqlite
    .query("SELECT 1 FROM sqlite_master WHERE type='index' AND name = ?")
    .get(name);
}

describe("migration 309: drop redundant indexes", () => {
  test("drops the nine redundant indexes and keeps their subsumers", () => {
    const { sqlite, db } = createTestDb();
    for (const name of [...DROPPED, ...KEPT]) {
      expect(indexExists(sqlite, name)).toBe(true);
    }

    migrateDropRedundantIndexes(db);

    for (const name of DROPPED) {
      expect(indexExists(sqlite, name)).toBe(false);
    }
    for (const name of KEPT) {
      expect(indexExists(sqlite, name)).toBe(true);
    }
  });

  test("is idempotent — re-run is a no-op (IF EXISTS)", () => {
    const { sqlite, db } = createTestDb();

    migrateDropRedundantIndexes(db);
    expect(() => migrateDropRedundantIndexes(db)).not.toThrow();

    for (const name of DROPPED) {
      expect(indexExists(sqlite, name)).toBe(false);
    }
  });

  test("tolerates databases where the indexes were never created", () => {
    const sqlite = new Database(":memory:");
    const db = drizzle(sqlite, { schema });
    expect(() => migrateDropRedundantIndexes(db)).not.toThrow();
  });
});
