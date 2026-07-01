import { Database } from "bun:sqlite";
import { describe, expect, test } from "bun:test";

import { drizzle } from "drizzle-orm/bun-sqlite";

import { getSqliteFrom } from "../../db-connection.js";
import * as schema from "../../schema.js";
import { migrateCreateA2aInvitesTable } from "../313-create-a2a-invites.js";

function createTestDb() {
  const sqlite = new Database(":memory:");
  sqlite.exec("PRAGMA journal_mode=WAL");
  return drizzle(sqlite, { schema });
}

function createSourceTable(raw: Database): void {
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
      contact_id TEXT NOT NULL,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);
}

function seedInvite(
  raw: Database,
  opts: {
    id: string;
    sourceChannel: string;
    status?: string;
    useCount?: number;
    redeemedBy?: string | null;
    redeemedAt?: number | null;
  },
): void {
  raw.run(
    `INSERT INTO assistant_ingress_invites
       (id, source_channel, token_hash, max_uses, use_count, expires_at,
        status, redeemed_by_external_user_id, redeemed_at, contact_id,
        created_at, updated_at)
     VALUES (?, ?, ?, 1, ?, 9999999999999, ?, ?, ?, ?, 1000, 1000)`,
    [
      opts.id,
      opts.sourceChannel,
      `hash-${opts.id}`,
      opts.useCount ?? 0,
      opts.status ?? "active",
      opts.redeemedBy ?? null,
      opts.redeemedAt ?? null,
      `contact-${opts.id}`,
    ],
  );
}

interface A2aInviteRow {
  id: string;
  token_hash: string;
  contact_id: string;
  max_uses: number;
  use_count: number;
  status: string;
  redeemed_by_external_user_id: string | null;
  redeemed_at: number | null;
}

function listA2aInvites(raw: Database): A2aInviteRow[] {
  return raw
    .prepare(`SELECT * FROM a2a_invites ORDER BY id`)
    .all() as A2aInviteRow[];
}

describe("migration 313 — create a2a_invites", () => {
  test("creates the table and copies only a2a rows from assistant_ingress_invites", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    createSourceTable(raw);
    seedInvite(raw, { id: "inv-a2a-1", sourceChannel: "a2a" });
    seedInvite(raw, {
      id: "inv-a2a-2",
      sourceChannel: "a2a",
      status: "redeemed",
      useCount: 1,
      redeemedBy: "acceptor-1",
      redeemedAt: 2000,
    });
    seedInvite(raw, { id: "inv-telegram", sourceChannel: "telegram" });
    seedInvite(raw, { id: "inv-phone", sourceChannel: "phone" });

    migrateCreateA2aInvitesTable(db);

    const copied = listA2aInvites(raw);
    expect(copied.map((r) => r.id)).toEqual(["inv-a2a-1", "inv-a2a-2"]);
    expect(copied[0]).toMatchObject({
      token_hash: "hash-inv-a2a-1",
      contact_id: "contact-inv-a2a-1",
      max_uses: 1,
      use_count: 0,
      status: "active",
      redeemed_by_external_user_id: null,
      redeemed_at: null,
    });
    expect(copied[1]).toMatchObject({
      status: "redeemed",
      use_count: 1,
      redeemed_by_external_user_id: "acceptor-1",
      redeemed_at: 2000,
    });

    // Source rows are left untouched — the table drops wholesale later.
    const sourceCount = raw
      .prepare(`SELECT COUNT(*) AS n FROM assistant_ingress_invites`)
      .get() as { n: number };
    expect(sourceCount.n).toBe(4);
  });

  test("is idempotent — re-running does not duplicate or clobber rows", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);
    createSourceTable(raw);
    seedInvite(raw, { id: "inv-a2a-1", sourceChannel: "a2a" });

    migrateCreateA2aInvitesTable(db);

    // Mutate the copied row so a re-run's INSERT OR IGNORE must not clobber it.
    raw.run(`UPDATE a2a_invites SET status = 'redeemed', use_count = 1`);

    migrateCreateA2aInvitesTable(db);

    const rows = listA2aInvites(raw);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.status).toBe("redeemed");
    expect(rows[0]!.use_count).toBe(1);
  });

  test("creates an empty table when assistant_ingress_invites does not exist", () => {
    const db = createTestDb();
    const raw = getSqliteFrom(db);

    expect(() => migrateCreateA2aInvitesTable(db)).not.toThrow();
    expect(listA2aInvites(raw)).toHaveLength(0);
  });
});
