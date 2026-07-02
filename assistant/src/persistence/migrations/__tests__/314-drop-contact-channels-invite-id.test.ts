import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateDropContactChannelInviteId } from "../314-drop-contact-channels-invite-id.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

/** Seed the pre-migration schema: the invite table plus contact_channels with invite_id. */
function bootstrapLegacyTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE assistant_ingress_invites (
      id TEXT PRIMARY KEY,
      source_channel TEXT NOT NULL,
      token_hash TEXT NOT NULL,
      contact_id TEXT NOT NULL,
      expires_at INTEGER NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE contact_channels (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      type TEXT NOT NULL,
      address TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      external_chat_id TEXT,
      invite_id TEXT,
      last_seen_at INTEGER,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      last_interaction INTEGER,
      updated_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
}

function tableExists(raw: Database, table: string): boolean {
  return !!raw
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(table);
}

function columnNames(raw: Database, table: string): Set<string> {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return new Set(cols.map((c) => c.name));
}

describe("migration 314 — drop contact_channels.invite_id", () => {
  test("drops the invite_id column, preserving channel data", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapLegacyTables(raw);

    raw.run(
      `INSERT INTO contact_channels
         (id, contact_id, type, address, external_chat_id, invite_id, interaction_count, created_at)
       VALUES ('ch-1', 'ct-1', 'telegram', 'user-1', 'chat-1', 'inv-1', 7, 1000)`,
    );

    migrateDropContactChannelInviteId(db);

    const cols = columnNames(raw, "contact_channels");
    expect(cols.has("invite_id")).toBe(false);
    // Identity/INFO columns survive.
    for (const col of [
      "id",
      "contact_id",
      "type",
      "address",
      "is_primary",
      "external_chat_id",
      "last_seen_at",
      "interaction_count",
      "last_interaction",
    ]) {
      expect(cols.has(col)).toBe(true);
    }

    const row = raw
      .prepare(
        `SELECT contact_id, type, address, external_chat_id, interaction_count
           FROM contact_channels WHERE id = 'ch-1'`,
      )
      .get() as Record<string, unknown>;
    expect(row).toEqual({
      contact_id: "ct-1",
      type: "telegram",
      address: "user-1",
      external_chat_id: "chat-1",
      interaction_count: 7,
    });
  });

  test("leaves assistant_ingress_invites intact (gateway m0010 drops it after the m0009 backfill)", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapLegacyTables(raw);

    raw.run(
      `INSERT INTO assistant_ingress_invites
         (id, source_channel, token_hash, contact_id, expires_at, created_at, updated_at)
       VALUES ('inv-1', 'telegram', 'hash-1', 'ct-1', 9999999999999, 1000, 1000)`,
    );

    migrateDropContactChannelInviteId(db);

    expect(tableExists(raw, "assistant_ingress_invites")).toBe(true);
    const invite = raw
      .prepare(
        `SELECT token_hash FROM assistant_ingress_invites WHERE id = 'inv-1'`,
      )
      .get() as { token_hash: string };
    expect(invite.token_hash).toBe("hash-1");
  });

  test("is idempotent — re-running after the drop does not throw", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapLegacyTables(raw);

    migrateDropContactChannelInviteId(db);
    expect(() => migrateDropContactChannelInviteId(db)).not.toThrow();

    expect(columnNames(raw, "contact_channels").has("invite_id")).toBe(false);
  });

  test("no-ops on a fresh schema without the invite_id column", () => {
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

    expect(() => migrateDropContactChannelInviteId(db)).not.toThrow();
    expect(columnNames(raw, "contact_channels").has("invite_id")).toBe(false);
  });
});
