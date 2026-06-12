import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateContactChannelsUniqueExtUser } from "../282-contact-channels-unique-ext-user.js";

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
 * Bootstrap minimal contact_channels + contacts tables with a non-unique
 * index on (type, external_user_id) — the pre-migration state.
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

describe("migration 282 — contact_channels unique (type, external_user_id)", () => {
  test("no-op on clean database (no duplicates)", () => {
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
  });

  test("deduplicates rows keeping active over unverified", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertContact(raw, "c2");

    // Duplicate: same (type=slack, external_user_id=U123)
    insertChannel(raw, {
      id: "ch-active",
      contactId: "c1",
      type: "slack",
      address: "U123",
      externalUserId: "U123",
      status: "active",
      updatedAt: 900,
    });
    insertChannel(raw, {
      id: "ch-unverified",
      contactId: "c2",
      type: "slack",
      address: "U123",
      externalUserId: "U123",
      status: "unverified",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe("ch-active");
    expect(channels[0]!.status).toBe("active");
  });

  test("deduplicates rows keeping blocked over active (preserves deny state)", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertContact(raw, "c2");

    // Duplicate: same (type=slack, external_user_id=U789)
    // Active row exists, but user explicitly blocked this person — blocked must survive
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
      address: "U789",
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
      address: "U456",
      externalUserId: "U456",
      status: "unverified",
      updatedAt: 1000,
    });

    migrateContactChannelsUniqueExtUser(db);

    const channels = getAllChannels(raw);
    expect(channels).toHaveLength(1);
    expect(channels[0]!.id).toBe("ch-new");
  });

  test("does not touch rows with NULL external_user_id", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertContact(raw, "c2");

    // Two email channels with NULL externalUserId — should both survive
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
      contactId: "c2",
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

  test("drops both old non-unique and unique indexes on external_user_id", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    // Pre-migration: old non-unique index exists
    const beforeIndexes = getIndexes(raw);
    const oldIdx = beforeIndexes.find(
      (i) => i.name === "idx_contact_channels_type_ext_user",
    );
    expect(oldIdx).toBeDefined();
    expect(oldIdx!.unique).toBe(0);

    migrateContactChannelsUniqueExtUser(db);

    const afterIndexes = getIndexes(raw);
    // Both indexes on external_user_id should be gone
    expect(
      afterIndexes.find((i) => i.name === "idx_contact_channels_type_ext_user"),
    ).toBeUndefined();
    expect(
      afterIndexes.find(
        (i) => i.name === "idx_contact_channels_type_ext_user_unique",
      ),
    ).toBeUndefined();
  });

  test("no unique index on external_user_id after migration — duplicates allowed", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    bootstrap(db);

    insertContact(raw, "c1");
    insertContact(raw, "c2");
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

    // The unique index on external_user_id no longer exists, so duplicate
    // externalUserId values are allowed (identity is enforced via address).
    expect(() =>
      insertChannel(raw, {
        id: "ch2",
        contactId: "c2",
        type: "slack",
        address: "U789-alt",
        externalUserId: "U789",
        status: "unverified",
        updatedAt: 2000,
      }),
    ).not.toThrow();
  });

  test("unique index allows same externalUserId on different channel types", () => {
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

    migrateContactChannelsUniqueExtUser(db);

    // Same externalUserId but different type — should succeed
    expect(() =>
      insertChannel(raw, {
        id: "ch2",
        contactId: "c1",
        type: "telegram",
        address: "U111",
        externalUserId: "U111",
        status: "active",
        updatedAt: 1000,
      }),
    ).not.toThrow();

    const channels = getAllChannels(raw);
    expect(channels).toHaveLength(2);
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
  });
});
