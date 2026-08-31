import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateNotificationFilterRules } from "../375-notification-filter-rules.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec(
    `CREATE TABLE notification_preferences (
       id TEXT PRIMARY KEY,
       preference_text TEXT NOT NULL,
       applies_when_json TEXT NOT NULL DEFAULT '{}',
       priority INTEGER NOT NULL DEFAULT 0,
       created_at INTEGER NOT NULL,
       updated_at INTEGER NOT NULL
     )`,
  );
  return drizzle(sqlite, { schema });
}

function columnNames(raw: Database, table: string): string[] {
  const rows = raw.prepare(`PRAGMA table_info(${table})`).all() as Array<{
    name: string;
  }>;
  return rows.map((row) => row.name);
}

function insertPreference(raw: Database, id: string): void {
  raw.run(
    `INSERT INTO notification_preferences
       (id, preference_text, applies_when_json, priority, created_at, updated_at)
     VALUES (?, 'tell me about outages', '{}', 0, 1000, 1000)`,
    [id],
  );
}

describe("migration 375: notification filter rules", () => {
  test("adds the rule columns to notification_preferences", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateNotificationFilterRules(db);

    expect(columnNames(raw, "notification_preferences")).toEqual(
      expect.arrayContaining([
        "match_json",
        "tier",
        "provenance",
        "source_request_id",
        "status",
      ]),
    );
  });

  test("leaves an existing preference advisory", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    insertPreference(raw, "pref-1");

    migrateNotificationFilterRules(db);

    const row = raw
      .prepare(
        "SELECT match_json, tier, provenance, source_request_id, status FROM notification_preferences WHERE id = 'pref-1'",
      )
      .get() as {
      match_json: string;
      tier: string | null;
      provenance: string;
      source_request_id: string | null;
      status: string;
    };
    expect(row).toEqual({
      match_json: "{}",
      tier: null,
      provenance: "user",
      source_request_id: null,
      status: "active",
    });
  });

  test("creates the declines and interactions tables", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateNotificationFilterRules(db);

    expect(columnNames(raw, "notification_rule_declines").sort()).toEqual([
      "declined_at",
      "id",
      "proposed_tier",
      "request_id",
      "scope_key",
    ]);
    expect(columnNames(raw, "notification_interactions").sort()).toEqual([
      "delivery_id",
      "id",
      "kind",
      "normalized_json",
      "observed_at",
      "tier",
    ]);
    const indexes = raw
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'notification_interactions' AND sql IS NOT NULL`,
      )
      .all() as Array<{ name: string }>;
    expect(indexes.map((index) => index.name)).toEqual([
      "idx_notif_interactions_observed",
    ]);
  });

  test("one decline per scope", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    migrateNotificationFilterRules(db);
    raw.run(
      `INSERT INTO notification_rule_declines (id, scope_key, proposed_tier, request_id, declined_at)
       VALUES ('decline-1', 'scope-a', 'quiet', NULL, 1000)`,
    );

    expect(() =>
      raw.run(
        `INSERT INTO notification_rule_declines (id, scope_key, proposed_tier, request_id, declined_at)
         VALUES ('decline-2', 'scope-a', 'quiet', NULL, 2000)`,
      ),
    ).toThrow();
  });

  test("is idempotent and preserves existing rows", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    insertPreference(raw, "pref-1");

    migrateNotificationFilterRules(db);
    raw.run(
      `INSERT INTO notification_interactions (id, delivery_id, normalized_json, tier, kind, observed_at)
       VALUES ('interaction-1', 'delivery-1', '{}', 'quiet', 'dismissed', 1000)`,
    );

    expect(() => migrateNotificationFilterRules(db)).not.toThrow();

    const preferences = raw
      .prepare("SELECT id FROM notification_preferences")
      .all() as Array<{ id: string }>;
    expect(preferences).toEqual([{ id: "pref-1" }]);
    const interactions = raw
      .prepare("SELECT id FROM notification_interactions")
      .all() as Array<{ id: string }>;
    expect(interactions).toEqual([{ id: "interaction-1" }]);
  });
});
