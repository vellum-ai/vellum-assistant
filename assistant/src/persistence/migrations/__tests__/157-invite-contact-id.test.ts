import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateInviteContactId } from "../157-invite-contact-id.js";
import { tableExists, tableHasColumn } from "../schema-introspection.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function columnNotNull(raw: Database, name: string): boolean {
  const cols = raw.query(`PRAGMA table_info(assistant_ingress_invites)`).all() as Array<{
    name: string;
    notnull: number;
  }>;
  return cols.some((c) => c.name === name && c.notnull === 1);
}

describe("migrateInviteContactId", () => {
  test("rebuilds a legacy created_by_session_id table with NOT NULL contact_id", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    raw.exec(/*sql*/ `
      CREATE TABLE assistant_ingress_invites (
        id TEXT PRIMARY KEY,
        source_channel TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        created_by_session_id TEXT,
        note TEXT,
        max_uses INTEGER NOT NULL DEFAULT 1,
        use_count INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        redeemed_by_external_user_id TEXT,
        redeemed_by_external_chat_id TEXT,
        redeemed_at INTEGER,
        expected_external_user_id TEXT,
        voice_code_hash TEXT,
        voice_code_digits INTEGER,
        invite_code_hash TEXT,
        friend_name TEXT,
        guardian_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    raw.run(
      `INSERT INTO assistant_ingress_invites
         (id, source_channel, token_hash, created_by_session_id, max_uses, use_count,
          expires_at, status, created_at, updated_at)
       VALUES ('inv-keep', 'slack', 'hash-keep', 'conv-1', 1, 0, 9, 'active', 1, 1)`,
    );
    raw.exec(
      `ALTER TABLE assistant_ingress_invites ADD COLUMN contact_id TEXT`,
    );
    raw.run(
      `UPDATE assistant_ingress_invites SET contact_id = 'contact-keep' WHERE id = 'inv-keep'`,
    );
    raw.run(
      `INSERT INTO assistant_ingress_invites
         (id, source_channel, token_hash, max_uses, use_count, expires_at, status,
          created_at, updated_at)
       VALUES ('inv-drop', 'slack', 'hash-drop', 1, 0, 9, 'active', 1, 1)`,
    );

    migrateInviteContactId(db);

    expect(tableHasColumn(db, "assistant_ingress_invites", "contact_id")).toBe(
      true,
    );
    expect(columnNotNull(raw, "contact_id")).toBe(true);
    expect(
      tableHasColumn(db, "assistant_ingress_invites", "created_by_session_id"),
    ).toBe(true);
    const rows = raw
      .query(`SELECT id, contact_id FROM assistant_ingress_invites ORDER BY id`)
      .all() as Array<{ id: string; contact_id: string }>;
    expect(rows).toEqual([{ id: "inv-keep", contact_id: "contact-keep" }]);
  });

  test("rebuilds after created_by_session_id was renamed to source_conversation_id", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    raw.exec(/*sql*/ `
      CREATE TABLE assistant_ingress_invites (
        id TEXT PRIMARY KEY,
        source_channel TEXT NOT NULL,
        token_hash TEXT NOT NULL,
        source_conversation_id TEXT,
        note TEXT,
        max_uses INTEGER NOT NULL DEFAULT 1,
        use_count INTEGER NOT NULL DEFAULT 0,
        expires_at INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        redeemed_by_external_user_id TEXT,
        redeemed_by_external_chat_id TEXT,
        redeemed_at INTEGER,
        expected_external_user_id TEXT,
        voice_code_hash TEXT,
        voice_code_digits INTEGER,
        invite_code_hash TEXT,
        friend_name TEXT,
        guardian_name TEXT,
        created_at INTEGER NOT NULL,
        updated_at INTEGER NOT NULL
      )
    `);
    raw.exec(
      `ALTER TABLE assistant_ingress_invites ADD COLUMN contact_id TEXT`,
    );
    raw.run(
      `INSERT INTO assistant_ingress_invites
         (id, source_channel, token_hash, source_conversation_id, contact_id,
          max_uses, use_count, expires_at, status, created_at, updated_at)
       VALUES ('inv-1', 'slack', 'hash-1', 'conv-9', 'contact-1', 1, 0, 9, 'active', 1, 1)`,
    );

    migrateInviteContactId(db);

    expect(columnNotNull(raw, "contact_id")).toBe(true);
    expect(
      tableHasColumn(db, "assistant_ingress_invites", "source_conversation_id"),
    ).toBe(true);
    expect(
      tableHasColumn(db, "assistant_ingress_invites", "created_by_session_id"),
    ).toBe(false);
    const row = raw
      .query(
        `SELECT source_conversation_id, contact_id FROM assistant_ingress_invites WHERE id = 'inv-1'`,
      )
      .get() as { source_conversation_id: string; contact_id: string };
    expect(row).toEqual({
      source_conversation_id: "conv-9",
      contact_id: "contact-1",
    });
  });

  test("is a no-op when the table does not exist", () => {
    const db = createTestDb();
    migrateInviteContactId(db);
    expect(tableExists(db, "assistant_ingress_invites")).toBe(false);
  });
});
