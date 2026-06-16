import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateContactChannelsUniqueExtUser } from "../289-contact-channels-unique-ext-user.js";

interface IndexRow {
  name: string;
  unique: number;
}

interface ChannelRow {
  id: string;
  contact_id: string;
  type: string;
  address: string;
  external_user_id: string | null;
  status: string;
  updated_at: number | null;
}

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  sqlite.exec("PRAGMA foreign_keys = ON");
  return drizzle(sqlite, { schema });
}

/**
 * Bootstrap minimal contact_channels + contacts tables with a case-sensitive
 * unique index on (type, address) and a non-unique index on
 * (type, external_user_id) — the pre-migration state.
 */
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
  raw.exec(/*sql*/ `
    CREATE INDEX idx_contact_channels_type_ext_user
      ON contact_channels(type, external_user_id)
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
    updatedAt: number;
  },
): void {
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
      opts.updatedAt,
      opts.updatedAt,
    );
}

function getAllChannels(raw: Database): ChannelRow[] {
  return raw
    .query<ChannelRow, []>(`SELECT * FROM contact_channels ORDER BY id`)
    .all();
}

function getIndexes(raw: Database): IndexRow[] {
  return raw
    .query<
      IndexRow,
      []
    >(`SELECT name, "unique" FROM pragma_index_list('contact_channels')`)
    .all();
}

describe("migration 287 — dedup case collisions + drop ext_user indexes", () => {
  test("no-op on clean database (no duplicates), preserves original casing", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "slack",
      address: "U111",
      externalUserId: "U111",
      status: "active",
      updatedAt: 1000,
    });
    insertChannel(raw, {
      id: "ch2",
      contactId: "c1",
      type: "telegram",
      address: "T222",
      externalUserId: "T222",
      status: "active",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    expect(channels).toHaveLength(2);
    expect(channels.map((c) => c.id).sort()).toEqual(["ch1", "ch2"]);
    // Addresses preserve original casing
    expect(channels.find((c) => c.id === "ch1")!.address).toBe("U111");
    expect(channels.find((c) => c.id === "ch2")!.address).toBe("T222");
  });

  test("preserves original Slack address casing", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "slack",
      address: "U12345ABC",
      externalUserId: "U12345ABC",
      status: "active",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.address).toBe("U12345ABC");
    expect(channels[0]!.external_user_id).toBe("U12345ABC");
  });

  test("deduplicates historical case collisions (active wins over unverified)", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertContact(raw, "c2");

    // Two Slack channels with different casing — historical inconsistency.
    insertChannel(raw, {
      id: "ch-upper",
      contactId: "c1",
      type: "slack",
      address: "U12345",
      externalUserId: "U12345",
      status: "active",
      updatedAt: 1000,
    });
    insertChannel(raw, {
      id: "ch-lower",
      contactId: "c2",
      type: "slack",
      address: "u12345",
      externalUserId: "U12345",
      status: "unverified",
      updatedAt: 900,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    // Only one survives — active wins over unverified
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe("ch-upper");
    expect(channels[0]!.address).toBe("U12345");
  });

  test("deduplicates rows keeping blocked over active (preserves deny state)", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertContact(raw, "c2");

    insertChannel(raw, {
      id: "ch-active",
      contactId: "c1",
      type: "slack",
      address: "U789",
      externalUserId: "U789",
      status: "active",
      updatedAt: 1000,
    });
    insertChannel(raw, {
      id: "ch-blocked",
      contactId: "c2",
      type: "slack",
      address: "u789",
      externalUserId: "U789",
      status: "blocked",
      updatedAt: 800,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe("ch-blocked");
    expect(channels[0]!.status).toBe("blocked");
  });

  test("deduplicates rows keeping most recent when same status", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertContact(raw, "c2");

    insertChannel(raw, {
      id: "ch-old",
      contactId: "c1",
      type: "slack",
      address: "U456",
      externalUserId: "U456",
      status: "unverified",
      updatedAt: 500,
    });
    insertChannel(raw, {
      id: "ch-new",
      contactId: "c2",
      type: "slack",
      address: "u456",
      externalUserId: "U456",
      status: "unverified",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe("ch-new");
  });

  test("does not touch rows with different addresses on different types", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");

    insertChannel(raw, {
      id: "ch-email-1",
      contactId: "c1",
      type: "email",
      address: "user@example.com",
      externalUserId: null,
      status: "active",
      updatedAt: 1000,
    });
    insertChannel(raw, {
      id: "ch-email-2",
      contactId: "c1",
      type: "email",
      address: "user2@example.com",
      externalUserId: null,
      status: "active",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    expect(channels).toHaveLength(2);
  });

  test("preserves external_user_id index (dropped by follow-up migration)", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    const beforeIndexes = getIndexes(raw);
    const oldIdx = beforeIndexes.find(
      (i) => i.name === "idx_contact_channels_type_ext_user",
    );
    expect(oldIdx).toBeDefined();

    migrateContactChannelsUniqueExtUser(db);

    const afterIndexes = getIndexes(raw);
    // Index is preserved — lookups still use externalUserId until PR 2
    expect(
      afterIndexes.find((i) => i.name === "idx_contact_channels_type_ext_user"),
    ).toBeDefined();
  });

  test("preserves existing case-sensitive UNIQUE(type, address) index", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "slack",
      address: "U789",
      externalUserId: "U789",
      status: "active",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);

    // The unique index on (type, address) still exists
    const afterIndexes = getIndexes(raw);
    const typeAddrIdx = afterIndexes.find(
      (i) => i.name === "idx_contact_channels_type_address",
    );
    expect(typeAddrIdx).toBeDefined();
    expect(typeAddrIdx!.unique).toBe(1);
  });

  test("same address on different channel types both survive", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "slack",
      address: "U111",
      externalUserId: "U111",
      status: "active",
      updatedAt: 1000,
    });
    insertChannel(raw, {
      id: "ch2",
      contactId: "c1",
      type: "telegram",
      address: "U111",
      externalUserId: "U111",
      status: "active",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    expect(channels).toHaveLength(2);
  });

  test("does not normalize address casing (deferred to follow-up migration)", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    // Simulates old write path that lowercased the address
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "slack",
      address: "u12345abc",
      externalUserId: "U12345ABC",
      status: "active",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    expect(channels).toHaveLength(1);
    // Address is NOT normalized — casing restoration deferred to later migration
    expect(channels[0]!.address).toBe("u12345abc");
  });

  test("deduplicates rows sharing external_user_id but having different addresses", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertContact(raw, "c2");

    // Two rows with different addresses but same external_user_id.
    // Step 1 (address dedup) keeps both since addresses differ.
    // Step 2 (external_user_id dedup) must reduce to one row to prevent
    // step 3 from creating an address collision.
    insertChannel(raw, {
      id: "ch-old-addr",
      contactId: "c1",
      type: "slack",
      address: "alice-old",
      externalUserId: "U12345",
      status: "unverified",
      updatedAt: 500,
    });
    insertChannel(raw, {
      id: "ch-correct",
      contactId: "c2",
      type: "slack",
      address: "U12345",
      externalUserId: "U12345",
      status: "active",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    // Only one survives — active wins over unverified
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe("ch-correct");
    expect(channels[0]!.address).toBe("U12345");
  });

  test("cross-column collision: row with NULL ext_user_id removed as blocker", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertContact(raw, "c2");

    // Row A: has external_user_id but stale lowercased address
    insertChannel(raw, {
      id: "ch-normalizer",
      contactId: "c1",
      type: "slack",
      address: "old-handle",
      externalUserId: "U12345",
      status: "active",
      updatedAt: 2000,
    });

    // Row B: occupies the target address with NULL external_user_id
    insertChannel(raw, {
      id: "ch-blocker",
      contactId: "c2",
      type: "slack",
      address: "U12345",
      externalUserId: null,
      status: "unverified",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    // Blocker removed; normalizer keeps its address (normalization deferred)
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe("ch-normalizer");
    expect(channels[0]!.address).toBe("old-handle");
  });

  test("cross-column collision: case-insensitive match removes lowercased blocker", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertContact(raw, "c2");

    // Row A: has external_user_id with original Slack casing
    insertChannel(raw, {
      id: "ch-normalizer",
      contactId: "c1",
      type: "slack",
      address: "old-handle",
      externalUserId: "U12345ABC",
      status: "active",
      updatedAt: 2000,
    });

    // Row B: occupies a lowercased variant of the target address (from old write paths)
    insertChannel(raw, {
      id: "ch-blocker",
      contactId: "c2",
      type: "slack",
      address: "u12345abc",
      externalUserId: null,
      status: "unverified",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    // Blocker removed despite case difference — COLLATE NOCASE catches it
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe("ch-normalizer");
    expect(channels[0]!.address).toBe("old-handle");
  });

  test("idempotent — safe to run twice", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertChannel(raw, {
      id: "ch1",
      contactId: "c1",
      type: "slack",
      address: "U999",
      externalUserId: "U999",
      status: "active",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);
    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    expect(channels).toHaveLength(1);
    // Original casing preserved
    expect(channels[0]!.address).toBe("U999");
  });
});
