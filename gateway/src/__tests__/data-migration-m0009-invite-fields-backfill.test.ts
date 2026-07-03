/**
 * Tests for m0009-invite-fields-backfill.
 *
 * Verifies that assistant ingress invites are backfilled into the gateway
 * `ingress_invites` table with the full widened field set: existing gateway
 * rows get the new columns UPDATEd (incl. correcting an m0007-era collapsed
 * invite_code_hash to the assistant's true value or the NO_INVITE_CODE_HASH
 * sentinel) without touching lifecycle columns, missing rows are INSERTed
 * with all fields, a2a invites are never copied, inserts are FK-safe, and the
 * whole migration is idempotent. Uses the same fake-assistant-DB +
 * real in-memory gateway-DB pattern as the m0007 test.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
  mock,
} from "bun:test";

import "./test-preload.js";

// ── Fake assistant DB ───────────────────────────────────────────────────────

type FakeInvite = {
  id: string;
  source_channel: string;
  invite_code_hash: string | null;
  token_hash: string | null;
  voice_code_hash: string | null;
  voice_code_digits: number | null;
  expected_external_user_id: string | null;
  friend_name: string | null;
  guardian_name: string | null;
  source_conversation_id: string | null;
  note: string | null;
  max_uses: number;
  use_count: number;
  expires_at: number;
  status: string;
  redeemed_by_external_user_id: string | null;
  redeemed_by_external_chat_id: string | null;
  redeemed_at: number | null;
  contact_id: string | null;
  created_at: number;
  updated_at: number;
};

const fakeAssistantDb = {
  invites: new Map<string, FakeInvite>(),
  hasInvitesTable: true,
  reset(): void {
    this.invites.clear();
    this.hasInvitesTable = true;
  },
};

mock.module("../db/assistant-db-proxy.js", () => ({
  assistantDbQuery: mock(async (sql: string) => {
    const lower = sql.toLowerCase();
    if (
      lower.includes("sqlite_master") &&
      lower.includes("'assistant_ingress_invites'")
    ) {
      return fakeAssistantDb.hasInvitesTable ? [{ "1": 1 }] : [];
    }
    if (lower.includes("from assistant_ingress_invites")) {
      const rows = Array.from(fakeAssistantDb.invites.values());
      // Honor the migration's a2a exclusion predicate when present.
      return lower.includes("source_channel != 'a2a'")
        ? rows.filter((r) => r.source_channel !== "a2a")
        : rows;
    }
    return [];
  }),
  assistantDbRun: mock(async () => ({ changes: 1, lastInsertRowid: 0 })),
  assistantDbExec: mock(async () => undefined),
}));

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, ingressInvites } from "../db/schema.js";
import { NO_INVITE_CODE_HASH } from "../db/contact-store.js";
import {
  up as m0009Up,
  down as m0009Down,
} from "../db/data-migrations/m0009-invite-fields-backfill.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(ingressInvites).run();
  db.delete(contacts).run();
  fakeAssistantDb.reset();
});

afterAll(() => {
  resetGatewayDb();
});

// ── Helpers ─────────────────────────────────────────────────────────────────

function seedGatewayContact(id: string): void {
  getGatewayDb()
    .insert(contacts)
    .values({
      id,
      displayName: `gw-${id}`,
      role: "contact",
      principalId: null,
      createdAt: 500,
      updatedAt: 500,
    })
    .run();
}

function seedGatewayInvite(
  opts: Partial<typeof ingressInvites.$inferInsert> & { id: string },
): void {
  getGatewayDb()
    .insert(ingressInvites)
    .values({
      sourceChannel: "telegram",
      inviteCodeHash: "gw-code-hash",
      contactId: "c1",
      note: null,
      maxUses: 1,
      useCount: 0,
      expiresAt: 9_999_999,
      status: "active",
      createdAt: 100,
      updatedAt: 200,
      ...opts,
    })
    .run();
}

function seedAssistantInvite(opts: Partial<FakeInvite> & { id: string }): void {
  // Defaults via spread so explicit `null` overrides (e.g. invite_code_hash:
  // null for voice invites) are preserved rather than coalesced.
  fakeAssistantDb.invites.set(opts.id, {
    source_channel: "telegram",
    invite_code_hash: "code-hash",
    token_hash: "token-hash",
    voice_code_hash: null,
    voice_code_digits: null,
    expected_external_user_id: null,
    friend_name: null,
    guardian_name: null,
    source_conversation_id: null,
    note: null,
    max_uses: 1,
    use_count: 0,
    expires_at: 9_999_999,
    status: "active",
    redeemed_by_external_user_id: null,
    redeemed_by_external_chat_id: null,
    redeemed_at: null,
    contact_id: null,
    created_at: 100,
    updated_at: 200,
    ...opts,
  });
}

function gatewayInviteIds(): string[] {
  const rows = getGatewayDb().$client
    .prepare("SELECT id FROM ingress_invites")
    .all() as { id: string }[];
  return rows.map((r) => r.id).sort();
}

function gatewayInvite(id: string): Record<string, unknown> | undefined {
  return getGatewayDb().$client
    .prepare("SELECT * FROM ingress_invites WHERE id = ?")
    .get(id) as Record<string, unknown> | undefined;
}

// ── Tests ───────────────────────────────────────────────────────────────────

describe("m0009-invite-fields-backfill", () => {
  test("updates an existing gateway row with the widened fields", async () => {
    seedGatewayContact("c1");
    seedGatewayInvite({ id: "inv-1", inviteCodeHash: "the-code-hash" });
    seedAssistantInvite({
      id: "inv-1",
      contact_id: "c1",
      invite_code_hash: "the-code-hash",
      token_hash: "tok-1",
      voice_code_hash: null,
      voice_code_digits: null,
      expected_external_user_id: "+15550100",
      friend_name: "Alice",
      guardian_name: "Bob",
      source_conversation_id: "conv-xyz",
    });

    const result = await m0009Up();

    expect(result).toBe("done");
    const row = gatewayInvite("inv-1")!;
    expect(row.invite_code_hash).toBe("the-code-hash");
    expect(row.token_hash).toBe("tok-1");
    expect(row.voice_code_hash).toBeNull();
    expect(row.voice_code_digits).toBeNull();
    expect(row.expected_external_user_id).toBe("+15550100");
    expect(row.friend_name).toBe("Alice");
    expect(row.guardian_name).toBe("Bob");
    expect(row.source_conversation_id).toBe("conv-xyz");
  });

  test("corrects an m0007-collapsed voice hash to the sentinel + voice_code_hash", async () => {
    seedGatewayContact("c1");
    // m0007 collapsed the voice hash into invite_code_hash for voice invites.
    seedGatewayInvite({
      id: "voice-1",
      sourceChannel: "phone",
      inviteCodeHash: "voice-hash",
    });
    seedAssistantInvite({
      id: "voice-1",
      contact_id: "c1",
      source_channel: "phone",
      invite_code_hash: null,
      token_hash: "tok-v",
      voice_code_hash: "voice-hash",
      voice_code_digits: 6,
      friend_name: "Carol",
    });

    await m0009Up();

    const row = gatewayInvite("voice-1")!;
    expect(row.invite_code_hash).toBe(NO_INVITE_CODE_HASH);
    expect(row.voice_code_hash).toBe("voice-hash");
    expect(row.voice_code_digits).toBe(6);
    expect(row.token_hash).toBe("tok-v");
    expect(row.friend_name).toBe("Carol");
  });

  test("update never touches lifecycle columns (gateway truth)", async () => {
    seedGatewayContact("c1");
    seedGatewayInvite({
      id: "inv-1",
      status: "revoked",
      useCount: 3,
      note: "gateway-note",
      redeemedAt: 4242,
    });
    seedAssistantInvite({
      id: "inv-1",
      contact_id: "c1",
      status: "active",
      use_count: 0,
      note: "assistant-note",
      redeemed_at: null,
    });

    await m0009Up();

    const row = gatewayInvite("inv-1")!;
    expect(row.status).toBe("revoked");
    expect(row.use_count).toBe(3);
    expect(row.note).toBe("gateway-note");
    expect(row.redeemed_at).toBe(4242);
  });

  test("inserts a missing invite with the full field set", async () => {
    seedGatewayContact("c1");
    seedAssistantInvite({
      id: "inv-new",
      contact_id: "c1",
      source_channel: "phone",
      invite_code_hash: null,
      token_hash: "tok-n",
      voice_code_hash: "voice-n",
      voice_code_digits: 4,
      expected_external_user_id: "+15550101",
      friend_name: "Dave",
      guardian_name: "Erin",
      source_conversation_id: "conv-abc",
      note: "hello",
      max_uses: 2,
      use_count: 1,
      expires_at: 12345,
      status: "redeemed",
      redeemed_by_external_user_id: "u-9",
      redeemed_by_external_chat_id: "chat-9",
      redeemed_at: 7777,
      created_at: 111,
      updated_at: 222,
    });

    const result = await m0009Up();

    expect(result).toBe("done");
    const row = gatewayInvite("inv-new")!;
    expect(row.source_channel).toBe("phone");
    // NULL assistant invite_code_hash lands as the NOT NULL sentinel.
    expect(row.invite_code_hash).toBe(NO_INVITE_CODE_HASH);
    expect(row.token_hash).toBe("tok-n");
    expect(row.voice_code_hash).toBe("voice-n");
    expect(row.voice_code_digits).toBe(4);
    expect(row.expected_external_user_id).toBe("+15550101");
    expect(row.friend_name).toBe("Dave");
    expect(row.guardian_name).toBe("Erin");
    expect(row.source_conversation_id).toBe("conv-abc");
    expect(row.note).toBe("hello");
    expect(row.max_uses).toBe(2);
    expect(row.use_count).toBe(1);
    expect(row.expires_at).toBe(12345);
    expect(row.status).toBe("redeemed");
    expect(row.redeemed_by_external_user_id).toBe("u-9");
    expect(row.redeemed_by_external_chat_id).toBe("chat-9");
    expect(row.redeemed_at).toBe(7777);
    expect(row.contact_id).toBe("c1");
    expect(row.created_at).toBe(111);
    expect(row.updated_at).toBe(222);
  });

  test("never copies a2a invites", async () => {
    seedGatewayContact("c1");
    seedAssistantInvite({ id: "a2a-1", contact_id: "c1", source_channel: "a2a" });
    seedAssistantInvite({ id: "tg-1", contact_id: "c1" });

    const result = await m0009Up();

    expect(result).toBe("done");
    expect(gatewayInviteIds()).toEqual(["tg-1"]);
  });

  test("skips inserting an invite whose contactId is absent from gateway contacts", async () => {
    seedAssistantInvite({ id: "orphan", contact_id: "ghost" });
    seedAssistantInvite({ id: "nullc", contact_id: null });
    seedGatewayContact("c1");
    seedAssistantInvite({ id: "ok", contact_id: "c1" });

    const result = await m0009Up();

    expect(result).toBe("done");
    expect(gatewayInviteIds()).toEqual(["ok"]);
  });

  test("idempotent: running twice yields the same rows and values", async () => {
    seedGatewayContact("c1");
    seedGatewayInvite({ id: "inv-1", inviteCodeHash: "voice-hash" });
    seedAssistantInvite({
      id: "inv-1",
      contact_id: "c1",
      invite_code_hash: null,
      voice_code_hash: "voice-hash",
    });
    seedAssistantInvite({ id: "inv-2", contact_id: "c1" });

    await m0009Up();
    const firstRun = {
      ids: gatewayInviteIds(),
      inv1: gatewayInvite("inv-1"),
      inv2: gatewayInvite("inv-2"),
    };
    await m0009Up();

    expect(gatewayInviteIds()).toEqual(firstRun.ids);
    expect(gatewayInvite("inv-1")).toEqual(firstRun.inv1);
    expect(gatewayInvite("inv-2")).toEqual(firstRun.inv2);
  });

  test("returns done when assistant DB has no invites table", async () => {
    fakeAssistantDb.hasInvitesTable = false;

    const result = await m0009Up();

    expect(result).toBe("done");
    expect(gatewayInviteIds()).toEqual([]);
  });

  test("does not drop or alter the assistant table (copy, not move)", async () => {
    seedGatewayContact("c1");
    seedAssistantInvite({ id: "inv-1", contact_id: "c1" });

    await m0009Up();

    expect(fakeAssistantDb.hasInvitesTable).toBe(true);
    expect(fakeAssistantDb.invites.has("inv-1")).toBe(true);
  });

  test("down is a no-op (returns done)", () => {
    expect(m0009Down()).toBe("done");
  });
});
