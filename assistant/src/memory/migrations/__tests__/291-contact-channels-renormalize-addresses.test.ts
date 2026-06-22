import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateContactChannelsRenormalizeAddresses } from "../291-contact-channels-renormalize-addresses.js";

interface ChannelRow {
  id: string;
  contact_id: string;
  type: string;
  address: string;
  external_user_id: string | null;
  status: string;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

function bootstrap(db: ReturnType<typeof createTestDb>): void {
  const raw = getSqliteFrom(db);
  raw.exec(/*sql*/ `
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'contact',
      contact_type TEXT NOT NULL DEFAULT 'human'
    )
  `);
  raw.exec(/*sql*/ `
    CREATE TABLE contact_channels (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
      type TEXT NOT NULL,
      address TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      external_user_id TEXT,
      external_chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'unverified',
      policy TEXT NOT NULL DEFAULT 'allow',
      interaction_count INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER,
      created_at INTEGER NOT NULL
    )
  `);
  raw.exec(/*sql*/ `
    CREATE UNIQUE INDEX idx_contact_channels_type_address
      ON contact_channels(type, address)
  `);
}

function insertContact(raw: Database, id: string): void {
  const now = Date.now();
  raw
    .query(
      `INSERT INTO contacts (id, display_name, created_at, updated_at) VALUES (?, ?, ?, ?)`,
    )
    .run(id, `Contact ${id}`, now, now);
}

function insertChannel(
  raw: Database,
  opts: {
    id: string;
    contactId: string;
    type: string;
    address: string;
    externalUserId: string | null;
    status: string;
  },
): void {
  const now = Date.now();
  raw
    .query(
      `INSERT INTO contact_channels (id, contact_id, type, address, external_user_id, status, updated_at, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      opts.id,
      opts.contactId,
      opts.type,
      opts.address,
      opts.externalUserId,
      opts.status,
      now,
      now,
    );
}

describe("migration 291 — renormalize addresses", () => {
  test("restores Slack address casing from external_user_id", () => {
    const db = createTestDb();
    bootstrap(db);
    const raw = getSqliteFrom(db);

    insertContact(raw, "c1");
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "slack",
      address: "u12345abc",
      externalUserId: "U12345ABC",
      status: "active",
    });

    migrateContactChannelsRenormalizeAddresses(db);

    const rows = raw
      .prepare("SELECT * FROM contact_channels")
      .all() as ChannelRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("U12345ABC");
  });

  test("preserves lowercase email addresses (does not overwrite with mixed-case external_user_id)", () => {
    const db = createTestDb();
    bootstrap(db);
    const raw = getSqliteFrom(db);

    insertContact(raw, "c1");
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "email",
      address: "user@example.com",
      // generic-examples:ignore-next-line — reason: testing mixed-case email normalization
      externalUserId: "User@Example.com",
      status: "active",
    });

    migrateContactChannelsRenormalizeAddresses(db);

    const rows = raw
      .prepare("SELECT * FROM contact_channels")
      .all() as ChannelRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("user@example.com");
  });

  test("lowercases email address if it was stored incorrectly", () => {
    const db = createTestDb();
    bootstrap(db);
    const raw = getSqliteFrom(db);

    insertContact(raw, "c1");
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "email",
      // generic-examples:ignore-next-line — reason: testing mixed-case email stored incorrectly
      address: "User@Example.com",
      // generic-examples:ignore-next-line — reason: testing mixed-case email stored incorrectly
      externalUserId: "User@Example.com",
      status: "active",
    });

    migrateContactChannelsRenormalizeAddresses(db);

    const rows = raw
      .prepare("SELECT * FROM contact_channels")
      .all() as ChannelRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("user@example.com");
  });

  test("removes cross-column blocker before normalization", () => {
    const db = createTestDb();
    bootstrap(db);
    const raw = getSqliteFrom(db);

    insertContact(raw, "c1");
    insertContact(raw, "c2");
    // Blocker: NULL external_user_id, address matches normalizer's external_user_id
    insertChannel(raw, {
      id: "blocker",
      contactId: "c1",
      type: "slack",
      address: "u12345abc",
      externalUserId: null,
      status: "unverified",
    });
    // Normalizer: has external_user_id that will become its address
    insertChannel(raw, {
      id: "normalizer",
      contactId: "c2",
      type: "slack",
      address: "old-address",
      externalUserId: "U12345ABC",
      status: "active",
    });

    migrateContactChannelsRenormalizeAddresses(db);

    const rows = raw
      .prepare("SELECT * FROM contact_channels ORDER BY id")
      .all() as ChannelRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe("normalizer");
    expect(rows[0].address).toBe("U12345ABC");
  });

  test("idempotent — safe to run twice", () => {
    const db = createTestDb();
    bootstrap(db);
    const raw = getSqliteFrom(db);

    insertContact(raw, "c1");
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "slack",
      address: "u12345abc",
      externalUserId: "U12345ABC",
      status: "active",
    });

    migrateContactChannelsRenormalizeAddresses(db);
    migrateContactChannelsRenormalizeAddresses(db);

    const rows = raw
      .prepare("SELECT * FROM contact_channels")
      .all() as ChannelRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("U12345ABC");
  });

  test("does not overwrite canonical E.164 phone address with raw external_user_id", () => {
    const db = createTestDb();
    bootstrap(db);
    const raw = getSqliteFrom(db);

    insertContact(raw, "c1");
    // Phone channel whose address was canonicalized to E.164 (+1 prefix)
    // but external_user_id still holds the raw 10-digit number.
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "phone",
      // generic-examples:ignore-next-line — reason: testing E.164 canonicalization preservation
      address: "+15550101234",
      // generic-examples:ignore-next-line — reason: testing raw 10-digit phone before E.164 normalization
      externalUserId: "5550101234",
      status: "active",
    });

    migrateContactChannelsRenormalizeAddresses(db);

    const rows = raw
      .prepare("SELECT * FROM contact_channels")
      .all() as ChannelRow[];
    expect(rows).toHaveLength(1);
    // generic-examples:ignore-next-line — reason: verifying E.164 address preserved
    expect(rows[0].address).toBe("+15550101234");
  });

  test("does not overwrite canonical WhatsApp address with raw external_user_id", () => {
    const db = createTestDb();
    bootstrap(db);
    const raw = getSqliteFrom(db);

    insertContact(raw, "c1");
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "whatsapp",
      address: "+447911123456",
      externalUserId: "447911123456",
      status: "active",
    });

    migrateContactChannelsRenormalizeAddresses(db);

    const rows = raw
      .prepare("SELECT * FROM contact_channels")
      .all() as ChannelRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("+447911123456");
  });

  test("no-op when address already matches external_user_id", () => {
    const db = createTestDb();
    bootstrap(db);
    const raw = getSqliteFrom(db);

    insertContact(raw, "c1");
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "slack",
      address: "U12345ABC",
      externalUserId: "U12345ABC",
      status: "active",
    });

    migrateContactChannelsRenormalizeAddresses(db);

    const rows = raw
      .prepare("SELECT * FROM contact_channels")
      .all() as ChannelRow[];
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("U12345ABC");
  });

  test("no-op when external_user_id column is absent (re-run after migration 294)", () => {
    const db = createTestDb();
    bootstrap(db);
    const raw = getSqliteFrom(db);

    insertContact(raw, "c1");
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "slack",
      address: "u12345abc",
      externalUserId: "U12345ABC",
      status: "active",
    });

    // Simulate a later startup where migration 294 has already dropped the
    // index and column. Migration steps re-run on every startup, so this must
    // tolerate the dropped column rather than throwing "no such column".
    raw.run("DROP INDEX IF EXISTS idx_contact_channels_type_ext_user");
    raw.run("ALTER TABLE contact_channels DROP COLUMN external_user_id");

    expect(() => migrateContactChannelsRenormalizeAddresses(db)).not.toThrow();

    const rows = raw
      .prepare("SELECT id, address FROM contact_channels")
      .all() as { id: string; address: string }[];
    expect(rows).toHaveLength(1);
    expect(rows[0].address).toBe("u12345abc");
  });
});
