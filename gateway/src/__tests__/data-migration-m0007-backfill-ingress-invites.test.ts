/**
 * Tests for m0007-backfill-ingress-invites.
 *
 * Verifies that assistant ingress invites are copied into the gateway
 * `ingress_invites` table with the SAME id and correct column mapping (incl.
 * the inviteCodeHash COALESCE for voice invites), are FK-safe (rows whose
 * contact is missing from the gateway are skipped), are idempotent
 * (INSERT OR IGNORE never duplicates or clobbers), and never drop/alter the
 * assistant table. Uses the same fake-assistant-DB + real in-memory gateway-DB
 * pattern as the m0006 reconcile test.
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
  voice_code_hash: string | null;
  token_hash: string | null;
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
      return Array.from(fakeAssistantDb.invites.values());
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
import {
  up as m0007Up,
  down as m0007Down,
} from "../db/data-migrations/m0007-backfill-ingress-invites.js";

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

function seedAssistantInvite(opts: Partial<FakeInvite> & { id: string }): void {
  // Defaults via spread so explicit `null` overrides (e.g. invite_code_hash:
  // null for voice/token-only invites) are preserved rather than coalesced.
  fakeAssistantDb.invites.set(opts.id, {
    source_channel: "telegram",
    invite_code_hash: "code-hash",
    voice_code_hash: null,
    token_hash: null,
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

describe("m0007-backfill-ingress-invites", () => {
  test("copies an active invite with the same id and full column mapping", async () => {
    seedGatewayContact("c1");
    seedAssistantInvite({
      id: "inv-1",
      contact_id: "c1",
      source_channel: "telegram",
      invite_code_hash: "the-code-hash",
      note: "hello",
      max_uses: 3,
      use_count: 1,
      expires_at: 12345,
      status: "active",
      created_at: 111,
      updated_at: 222,
    });

    const result = await m0007Up();

    expect(result).toBe("done");
    expect(gatewayInviteIds()).toEqual(["inv-1"]);

    const row = gatewayInvite("inv-1")!;
    expect(row.id).toBe("inv-1");
    expect(row.source_channel).toBe("telegram");
    expect(row.invite_code_hash).toBe("the-code-hash");
    expect(row.note).toBe("hello");
    expect(row.max_uses).toBe(3);
    expect(row.use_count).toBe(1);
    expect(row.expires_at).toBe(12345);
    expect(row.status).toBe("active");
    expect(row.contact_id).toBe("c1");
    expect(row.created_at).toBe(111);
    expect(row.updated_at).toBe(222);
  });

  test("inviteCodeHash COALESCE picks voice_code_hash for a voice invite", async () => {
    seedGatewayContact("c1");
    seedAssistantInvite({
      id: "voice-1",
      contact_id: "c1",
      invite_code_hash: null,
      voice_code_hash: "voice-hash",
      token_hash: null,
    });

    await m0007Up();

    expect(gatewayInvite("voice-1")!.invite_code_hash).toBe("voice-hash");
  });

  test("inviteCodeHash COALESCE falls back to token_hash when both others null", async () => {
    seedGatewayContact("c1");
    seedAssistantInvite({
      id: "tok-1",
      contact_id: "c1",
      invite_code_hash: null,
      voice_code_hash: null,
      token_hash: "token-hash",
    });

    await m0007Up();

    expect(gatewayInvite("tok-1")!.invite_code_hash).toBe("token-hash");
  });

  test("copies terminal (redeemed) invites with their real status", async () => {
    seedGatewayContact("c1");
    seedAssistantInvite({
      id: "redeemed-1",
      contact_id: "c1",
      status: "redeemed",
      use_count: 1,
      redeemed_by_external_user_id: "u-9",
      redeemed_by_external_chat_id: "chat-9",
      redeemed_at: 7777,
    });

    await m0007Up();

    const row = gatewayInvite("redeemed-1")!;
    expect(row.status).toBe("redeemed");
    expect(row.redeemed_by_external_user_id).toBe("u-9");
    expect(row.redeemed_by_external_chat_id).toBe("chat-9");
    expect(row.redeemed_at).toBe(7777);
  });

  test("skips an invite whose contactId is absent from gateway contacts", async () => {
    // No gateway contact seeded for "ghost".
    seedAssistantInvite({ id: "orphan", contact_id: "ghost" });
    seedGatewayContact("c1");
    seedAssistantInvite({ id: "ok", contact_id: "c1" });

    const result = await m0007Up();

    expect(result).toBe("done");
    // Orphan skipped, valid one still copied — migration completes.
    expect(gatewayInviteIds()).toEqual(["ok"]);
  });

  test("skips an invite with a null contactId", async () => {
    seedAssistantInvite({ id: "nullc", contact_id: null });

    const result = await m0007Up();

    expect(result).toBe("done");
    expect(gatewayInviteIds()).toEqual([]);
  });

  test("skips an invite with no resolvable code hash", async () => {
    seedGatewayContact("c1");
    seedAssistantInvite({
      id: "nocode",
      contact_id: "c1",
      invite_code_hash: null,
      voice_code_hash: null,
      token_hash: null,
    });

    const result = await m0007Up();

    expect(result).toBe("done");
    expect(gatewayInviteIds()).toEqual([]);
  });

  test("idempotent: running twice does not duplicate", async () => {
    seedGatewayContact("c1");
    seedAssistantInvite({ id: "inv-1", contact_id: "c1" });

    await m0007Up();
    await m0007Up();

    expect(gatewayInviteIds()).toEqual(["inv-1"]);
  });

  test("INSERT OR IGNORE does not clobber a gateway row that already exists", async () => {
    seedGatewayContact("c1");
    // Pre-existing gateway row created post-migration with a different hash.
    getGatewayDb()
      .insert(ingressInvites)
      .values({
        id: "inv-1",
        sourceChannel: "telegram",
        inviteCodeHash: "gateway-native-hash",
        note: "gateway-native",
        maxUses: 1,
        useCount: 0,
        expiresAt: 1,
        status: "active",
        contactId: "c1",
        createdAt: 1,
        updatedAt: 1,
      })
      .run();

    seedAssistantInvite({
      id: "inv-1",
      contact_id: "c1",
      invite_code_hash: "assistant-hash",
      note: "assistant-note",
    });

    await m0007Up();

    const row = gatewayInvite("inv-1")!;
    // Gateway's version is preserved, not overwritten.
    expect(row.invite_code_hash).toBe("gateway-native-hash");
    expect(row.note).toBe("gateway-native");
  });

  test("does not drop or alter the assistant table (copy, not move)", async () => {
    seedGatewayContact("c1");
    seedAssistantInvite({ id: "inv-1", contact_id: "c1" });

    await m0007Up();

    // The fake assistant table still has the invite — nothing was dropped.
    expect(fakeAssistantDb.hasInvitesTable).toBe(true);
    expect(fakeAssistantDb.invites.has("inv-1")).toBe(true);
  });

  test("returns done when assistant DB has no invites table", async () => {
    fakeAssistantDb.hasInvitesTable = false;

    const result = await m0007Up();

    expect(result).toBe("done");
    expect(gatewayInviteIds()).toEqual([]);
  });

  test("down is a no-op (returns done)", () => {
    expect(m0007Down()).toBe("done");
  });
});
