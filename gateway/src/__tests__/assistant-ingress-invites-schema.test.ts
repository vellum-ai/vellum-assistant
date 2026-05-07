import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { Database } from "bun:sqlite";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import {
  initGatewayDb,
  resetGatewayDb,
  getGatewayDb,
} from "../db/connection.js";
import {
  assistantIngressInvites,
  contacts,
} from "../db/schema.js";
import { testSecurityDir } from "./test-preload.js";

// ---------------------------------------------------------------------------
// Schema verification for assistant_ingress_invites
//
// The table starts empty and only begins receiving writes once the
// invite-creation/redemption code paths are migrated to the gateway. This
// test ensures the schema (columns, defaults, FK, indexes) is in place so
// those follow-ups can land without surprises.
// ---------------------------------------------------------------------------

const dbPath = join(testSecurityDir, "gateway.sqlite");

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
});

afterEach(() => {
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function rawDb(): Database {
  // The drizzle bun-sqlite handle wraps a Database; the underlying file is
  // shared, so opening a fresh handle for introspection is safe and avoids
  // leaning on internals.
  return new Database(dbPath);
}

function tableInfo(name: string): Array<{
  name: string;
  type: string;
  notnull: number;
  dflt_value: string | null;
  pk: number;
}> {
  const db = rawDb();
  try {
    return db
      .query(`PRAGMA table_info(${name})`)
      .all() as ReturnType<typeof tableInfo>;
  } finally {
    db.close();
  }
}

function indexList(name: string): Array<{
  seq: number;
  name: string;
  unique: number;
  origin: string;
  partial: number;
}> {
  const db = rawDb();
  try {
    return db
      .query(`PRAGMA index_list(${name})`)
      .all() as ReturnType<typeof indexList>;
  } finally {
    db.close();
  }
}

function indexColumns(indexName: string): string[] {
  const db = rawDb();
  try {
    const rows = db
      .query(`PRAGMA index_info(${indexName})`)
      .all() as Array<{ seqno: number; cid: number; name: string }>;
    return rows
      .sort((a, b) => a.seqno - b.seqno)
      .map((r) => r.name);
  } finally {
    db.close();
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("assistant_ingress_invites schema", () => {
  test("table exists with all expected columns", () => {
    const cols = tableInfo("assistant_ingress_invites");
    const byName = new Map(cols.map((c) => [c.name, c]));

    const expected = [
      "id",
      "source_channel",
      "token_hash",
      "source_conversation_id",
      "note",
      "max_uses",
      "use_count",
      "expires_at",
      "status",
      "redeemed_by_external_user_id",
      "redeemed_by_external_chat_id",
      "redeemed_at",
      "expected_external_user_id",
      "voice_code_hash",
      "voice_code_digits",
      "invite_code_hash",
      "friend_name",
      "guardian_name",
      "contact_id",
      "created_at",
      "updated_at",
    ];

    for (const name of expected) {
      expect(byName.has(name)).toBe(true);
    }
    expect(cols.length).toBe(expected.length);
  });

  test("primary key on id, NOT NULL on required columns", () => {
    const cols = tableInfo("assistant_ingress_invites");
    const byName = new Map(cols.map((c) => [c.name, c]));

    expect(byName.get("id")?.pk).toBe(1);

    const requiredNotNull = [
      "id",
      "source_channel",
      "token_hash",
      "max_uses",
      "use_count",
      "expires_at",
      "status",
      "contact_id",
      "created_at",
      "updated_at",
    ];
    for (const name of requiredNotNull) {
      expect(byName.get(name)?.notnull).toBe(1);
    }

    const nullable = [
      "source_conversation_id",
      "note",
      "redeemed_by_external_user_id",
      "redeemed_by_external_chat_id",
      "redeemed_at",
      "expected_external_user_id",
      "voice_code_hash",
      "voice_code_digits",
      "invite_code_hash",
      "friend_name",
      "guardian_name",
    ];
    for (const name of nullable) {
      expect(byName.get(name)?.notnull).toBe(0);
    }
  });

  test("default values applied on insert", () => {
    const db = getGatewayDb();
    const now = Date.now();

    db.insert(contacts)
      .values({
        id: "contact-defaults",
        displayName: "Defaults Contact",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(assistantIngressInvites)
      .values({
        id: "invite-defaults",
        sourceChannel: "phone",
        tokenHash: "hash-defaults",
        expiresAt: now + 60_000,
        contactId: "contact-defaults",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const row = db
      .select()
      .from(assistantIngressInvites)
      .where(eq(assistantIngressInvites.id, "invite-defaults"))
      .get();

    expect(row).toBeDefined();
    expect(row?.maxUses).toBe(1);
    expect(row?.useCount).toBe(0);
    expect(row?.status).toBe("active");
  });

  test("contact_id foreign key cascades on contact delete", () => {
    const db = getGatewayDb();
    const now = Date.now();

    // FK enforcement is enabled by initGatewayDb (PRAGMA foreign_keys=ON in
    // connection.ts). No extra setup needed here.

    db.insert(contacts)
      .values({
        id: "contact-cascade",
        displayName: "Cascade Contact",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.insert(assistantIngressInvites)
      .values({
        id: "invite-cascade",
        sourceChannel: "phone",
        tokenHash: "hash-cascade",
        expiresAt: now + 60_000,
        contactId: "contact-cascade",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    db.delete(contacts)
      .where(eq(contacts.id, "contact-cascade"))
      .run();

    const row = db
      .select()
      .from(assistantIngressInvites)
      .where(eq(assistantIngressInvites.id, "invite-cascade"))
      .get();

    expect(row).toBeUndefined();
  });

  test("indexes exist with correct column composition", () => {
    const indexes = indexList("assistant_ingress_invites");
    const byName = new Map(indexes.map((i) => [i.name, i]));

    // Voice redemption: (source_channel, status, expected_external_user_id)
    const voice = byName.get("idx_assistant_ingress_invites_voice_lookup");
    expect(voice).toBeDefined();
    expect(indexColumns("idx_assistant_ingress_invites_voice_lookup")).toEqual([
      "source_channel",
      "status",
      "expected_external_user_id",
    ]);

    // 6-digit code redemption: (invite_code_hash, source_channel)
    const code = byName.get("idx_assistant_ingress_invites_code_lookup");
    expect(code).toBeDefined();
    expect(indexColumns("idx_assistant_ingress_invites_code_lookup")).toEqual([
      "invite_code_hash",
      "source_channel",
    ]);

    // Token-link redemption: (token_hash)
    const token = byName.get("idx_assistant_ingress_invites_token_hash");
    expect(token).toBeDefined();
    expect(indexColumns("idx_assistant_ingress_invites_token_hash")).toEqual([
      "token_hash",
    ]);

    // Contact-scoped lookups: (contact_id)
    const contact = byName.get("idx_assistant_ingress_invites_contact");
    expect(contact).toBeDefined();
    expect(indexColumns("idx_assistant_ingress_invites_contact")).toEqual([
      "contact_id",
    ]);
  });

});
