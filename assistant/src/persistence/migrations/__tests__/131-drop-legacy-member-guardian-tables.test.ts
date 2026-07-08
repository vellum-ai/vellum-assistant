import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateDropLegacyMemberGuardianTables } from "../131-drop-legacy-member-guardian-tables.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function bootstrap(db: ReturnType<typeof createTestDb>): void {
  const raw = getSqliteFrom(db);
  raw.exec(/*sql*/ `
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      role TEXT NOT NULL DEFAULT 'contact',
      principal_id TEXT,
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
      external_user_id TEXT,
      external_chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'unverified',
      policy TEXT NOT NULL DEFAULT 'allow',
      invite_id TEXT,
      revoked_reason TEXT,
      blocked_reason TEXT,
      last_seen_at INTEGER,
      verified_at INTEGER,
      verified_via TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX idx_contact_channels_type_ext_user
      ON contact_channels(type, external_user_id)
  `);
}

function createLegacyTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE channel_guardian_bindings (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      status TEXT NOT NULL,
      guardian_external_user_id TEXT,
      guardian_principal_id TEXT,
      guardian_delivery_chat_id TEXT,
      metadata_json TEXT,
      verified_at INTEGER,
      verified_via TEXT,
      created_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE assistant_ingress_members (
      id TEXT PRIMARY KEY,
      source_channel TEXT NOT NULL,
      external_user_id TEXT,
      external_chat_id TEXT,
      display_name TEXT,
      username TEXT,
      status TEXT NOT NULL,
      policy TEXT,
      invite_id TEXT,
      revoked_reason TEXT,
      blocked_reason TEXT,
      last_seen_at INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    )
  `);
}

function tableExists(raw: Database, name: string): boolean {
  return !!raw
    .prepare(`SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?`)
    .get(name);
}

function seedLegacyRows(raw: Database): void {
  raw.run(
    `INSERT INTO channel_guardian_bindings
       (id, channel, status, guardian_external_user_id, guardian_principal_id,
        guardian_delivery_chat_id, metadata_json, verified_at, verified_via, created_at)
     VALUES ('g1','telegram','active','U-guardian','prin-1','chat-1',NULL,1000,'telegram',1000)`,
  );
  raw.run(
    `INSERT INTO assistant_ingress_members
       (id, source_channel, external_user_id, external_chat_id, display_name,
        username, status, policy, invite_id, revoked_reason, blocked_reason,
        last_seen_at, created_at, updated_at)
     VALUES ('m1','slack','U-member',NULL,'Member One','member1','active','allow',
        NULL,NULL,NULL,2000,2000,2000)`,
  );
}

describe("migration 131 — drop legacy member/guardian tables", () => {
  test("syncs stragglers then drops the legacy tables when the column is present", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);
    createLegacyTables(raw);
    seedLegacyRows(raw);

    migrateDropLegacyMemberGuardianTables(db);

    // The straggler rows were synced into contact_channels.
    const synced = raw
      .prepare(`SELECT external_user_id FROM contact_channels ORDER BY id`)
      .all() as { external_user_id: string | null }[];
    expect(synced.map((r) => r.external_user_id).sort()).toEqual([
      "U-guardian",
      "U-member",
    ]);

    // The legacy tables were removed.
    expect(tableExists(raw, "channel_guardian_bindings")).toBe(false);
    expect(tableExists(raw, "assistant_ingress_members")).toBe(false);
  });

  test("drops the legacy tables without throwing when external_user_id is absent (re-run after migration 294)", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);
    createLegacyTables(raw);
    seedLegacyRows(raw);

    // Simulate a later startup where migration 294 has already dropped the
    // index + column. The sync references external_user_id, so 131 must skip it
    // and still drop the tables rather than failing on every boot.
    raw.run("DROP INDEX IF EXISTS idx_contact_channels_type_ext_user");
    raw.run("ALTER TABLE contact_channels DROP COLUMN external_user_id");

    expect(() => migrateDropLegacyMemberGuardianTables(db)).not.toThrow();

    expect(tableExists(raw, "channel_guardian_bindings")).toBe(false);
    expect(tableExists(raw, "assistant_ingress_members")).toBe(false);
  });
});
