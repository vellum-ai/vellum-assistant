import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateDropContactChannelTelemetry } from "../318-drop-contact-channel-telemetry.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

/** Seed the pre-migration schema: contact_channels with the telemetry columns. */
function bootstrapLegacyTable(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE contact_channels (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      type TEXT NOT NULL,
      address TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      external_chat_id TEXT,
      last_seen_at INTEGER,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      last_interaction INTEGER,
      updated_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
}

function columnNames(raw: Database, table: string): Set<string> {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return new Set(cols.map((c) => c.name));
}

const TELEMETRY_COLUMNS = [
  "last_seen_at",
  "interaction_count",
  "last_interaction",
];

describe("migration 318 — drop contact_channels telemetry columns", () => {
  test("drops all three telemetry columns, preserving other channel data", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapLegacyTable(raw);

    raw.run(
      `INSERT INTO contact_channels
         (id, contact_id, type, address, is_primary, external_chat_id,
          last_seen_at, interaction_count, last_interaction, updated_at, created_at)
       VALUES ('ch-1', 'ct-1', 'telegram', 'user-1', 1, 'chat-1',
          5000, 7, 6000, 8000, 1000)`,
    );

    migrateDropContactChannelTelemetry(db);

    const cols = columnNames(raw, "contact_channels");
    for (const col of TELEMETRY_COLUMNS) {
      expect(cols.has(col)).toBe(false);
    }
    // Identity/routing columns survive.
    for (const col of [
      "id",
      "contact_id",
      "type",
      "address",
      "is_primary",
      "external_chat_id",
      "updated_at",
      "created_at",
    ]) {
      expect(cols.has(col)).toBe(true);
    }

    const row = raw
      .prepare(
        `SELECT id, contact_id, type, address, is_primary, external_chat_id,
                updated_at, created_at
           FROM contact_channels WHERE id = 'ch-1'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      id: "ch-1",
      contact_id: "ct-1",
      type: "telegram",
      address: "user-1",
      is_primary: 1,
      external_chat_id: "chat-1",
      updated_at: 8000,
      created_at: 1000,
    });
  });

  test("is idempotent — re-running after the drop does not throw", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapLegacyTable(raw);

    migrateDropContactChannelTelemetry(db);
    expect(() => migrateDropContactChannelTelemetry(db)).not.toThrow();

    const cols = columnNames(raw, "contact_channels");
    for (const col of TELEMETRY_COLUMNS) {
      expect(cols.has(col)).toBe(false);
    }
  });

  test("no-ops on a fresh schema without the telemetry columns", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    raw.exec(/*sql*/ `
      CREATE TABLE contact_channels (
        id TEXT PRIMARY KEY,
        contact_id TEXT NOT NULL,
        type TEXT NOT NULL,
        address TEXT NOT NULL,
        created_at INTEGER NOT NULL
      )
    `);

    expect(() => migrateDropContactChannelTelemetry(db)).not.toThrow();
    const cols = columnNames(raw, "contact_channels");
    for (const col of TELEMETRY_COLUMNS) {
      expect(cols.has(col)).toBe(false);
    }
  });
});
