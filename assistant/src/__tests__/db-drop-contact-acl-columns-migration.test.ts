import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../persistence/db-connection.js";
import { migrateDropContactAclColumns } from "../persistence/migrations/305-drop-contact-acl-columns.js";
import * as schema from "../persistence/schema/index.js";

const DROPPED_CONTACT_COLUMNS = ["role", "principal_id"] as const;
const DROPPED_CHANNEL_COLUMNS = [
  "status",
  "policy",
  "verified_at",
  "verified_via",
  "revoked_reason",
  "blocked_reason",
] as const;
const KEPT_CHANNEL_COLUMNS = [
  "invite_id",
  "external_chat_id",
  "type",
  "address",
  "is_primary",
  "last_seen_at",
  "interaction_count",
  "last_interaction",
] as const;

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

/** Seed the pre-migration contacts/contact_channels schema (with ACL columns). */
function bootstrapLegacyTables(raw: Database): void {
  raw.exec(/*sql*/ `
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'contact',
      principal_id TEXT,
      user_file TEXT,
      contact_type TEXT NOT NULL DEFAULT 'human'
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
      status TEXT NOT NULL DEFAULT 'unverified',
      policy TEXT NOT NULL DEFAULT 'allow',
      verified_at INTEGER,
      verified_via TEXT,
      invite_id TEXT,
      revoked_reason TEXT,
      blocked_reason TEXT,
      last_seen_at INTEGER,
      interaction_count INTEGER NOT NULL DEFAULT 0,
      last_interaction INTEGER,
      updated_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE INDEX idx_contact_channels_type_ext_chat
      ON contact_channels(type, external_chat_id)
  `);
}

function columnNames(raw: Database, table: string): Set<string> {
  const cols = raw.prepare(`PRAGMA table_info(${table})`).all() as {
    name: string;
  }[];
  return new Set(cols.map((c) => c.name));
}

function indexNames(raw: Database, table: string): Set<string> {
  const idx = raw.prepare(`PRAGMA index_list(${table})`).all() as {
    name: string;
  }[];
  return new Set(idx.map((i) => i.name));
}

describe("migrateDropContactAclColumns", () => {
  test("drops the 8 ACL columns and keeps INFO/identity/invite columns", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapLegacyTables(raw);

    migrateDropContactAclColumns(db);

    const contactCols = columnNames(raw, "contacts");
    for (const col of DROPPED_CONTACT_COLUMNS) {
      expect(contactCols.has(col)).toBe(false);
    }
    // Identity/INFO columns survive.
    for (const col of [
      "id",
      "display_name",
      "notes",
      "user_file",
      "contact_type",
    ]) {
      expect(contactCols.has(col)).toBe(true);
    }

    const channelCols = columnNames(raw, "contact_channels");
    for (const col of DROPPED_CHANNEL_COLUMNS) {
      expect(channelCols.has(col)).toBe(false);
    }
    for (const col of KEPT_CHANNEL_COLUMNS) {
      expect(channelCols.has(col)).toBe(true);
    }
  });

  test("leaves the type/external_chat_id index intact", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapLegacyTables(raw);

    migrateDropContactAclColumns(db);

    expect(
      indexNames(raw, "contact_channels").has(
        "idx_contact_channels_type_ext_chat",
      ),
    ).toBe(true);
  });

  test("is idempotent — re-running on the dropped schema is a no-op", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrapLegacyTables(raw);

    migrateDropContactAclColumns(db);
    const afterFirst = {
      contacts: [...columnNames(raw, "contacts")].sort(),
      channels: [...columnNames(raw, "contact_channels")].sort(),
    };

    expect(() => migrateDropContactAclColumns(db)).not.toThrow();

    expect([...columnNames(raw, "contacts")].sort()).toEqual(
      afterFirst.contacts,
    );
    expect([...columnNames(raw, "contact_channels")].sort()).toEqual(
      afterFirst.channels,
    );
  });
});
