/**
 * Tests for ContactStore's ingress_invites CRUD — the gateway-DB-only data
 * access layer that the native HTTP invite handlers consume.
 *
 * These methods touch only the gateway DB (ingress_invites + contacts FK),
 * so no assistant DB proxy is needed. We spin up the in-memory/temp gateway
 * DB via the shared test preload and seed a contacts row to satisfy the
 * invite's contact_id FK.
 */

import {
  describe,
  test,
  expect,
  beforeAll,
  beforeEach,
  afterAll,
} from "bun:test";

import "./test-preload.js";

import { ContactStore } from "../db/contact-store.js";
import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { contacts, ingressInvites } from "../db/schema.js";

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(ingressInvites).run();
  db.delete(contacts).run();
});

afterAll(() => {
  resetGatewayDb();
});

function seedContact(id: string) {
  const now = Date.now();
  getGatewayDb()
    .insert(contacts)
    .values({
      id,
      displayName: `name-${id}`,
      role: "contact",
      principalId: `prin-${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

describe("ContactStore ingress_invites", () => {
  test("createInvite inserts an active invite with useCount 0 and returns the row", () => {
    seedContact("c1");
    const store = new ContactStore();
    const before = Date.now();

    const row = store.createInvite({
      id: "inv1",
      sourceChannel: "vellum",
      inviteCodeHash: "hash-1",
      contactId: "c1",
      note: "hello",
      maxUses: 3,
      expiresAt: 9999,
    });

    expect(row.id).toBe("inv1");
    expect(row.sourceChannel).toBe("vellum");
    expect(row.inviteCodeHash).toBe("hash-1");
    expect(row.note).toBe("hello");
    expect(row.maxUses).toBe(3);
    expect(row.useCount).toBe(0);
    expect(row.expiresAt).toBe(9999);
    expect(row.status).toBe("active");
    expect(row.contactId).toBe("c1");
    expect(row.redeemedAt).toBeNull();
    expect(row.createdAt).toBeGreaterThanOrEqual(before);
    expect(row.updatedAt).toBeGreaterThanOrEqual(before);
  });

  test("createInvite defaults note=null and maxUses=1", () => {
    seedContact("c1");
    const row = new ContactStore().createInvite({
      id: "inv1",
      sourceChannel: "vellum",
      inviteCodeHash: "hash-1",
      contactId: "c1",
      expiresAt: 9999,
    });
    expect(row.note).toBeNull();
    expect(row.maxUses).toBe(1);
  });

  test("getInviteById returns the row or null", () => {
    seedContact("c1");
    const store = new ContactStore();
    store.createInvite({
      id: "inv1",
      sourceChannel: "vellum",
      inviteCodeHash: "hash-1",
      contactId: "c1",
      expiresAt: 9999,
    });

    expect(store.getInviteById("inv1")?.id).toBe("inv1");
    expect(store.getInviteById("nope")).toBeNull();
  });

  test("listInvites filters by sourceChannel/status/contactId and orders by createdAt desc", () => {
    seedContact("c1");
    seedContact("c2");
    const store = new ContactStore();

    store.createInvite({
      id: "inv1",
      sourceChannel: "vellum",
      inviteCodeHash: "h1",
      contactId: "c1",
      expiresAt: 9999,
    });
    store.createInvite({
      id: "inv2",
      sourceChannel: "sms",
      inviteCodeHash: "h2",
      contactId: "c1",
      expiresAt: 9999,
    });
    store.createInvite({
      id: "inv3",
      sourceChannel: "vellum",
      inviteCodeHash: "h3",
      contactId: "c2",
      expiresAt: 9999,
    });

    // No filters → all three, newest first.
    const all = store.listInvites({});
    expect(all.map((r) => r.id)).toEqual(["inv3", "inv2", "inv1"]);

    expect(
      store.listInvites({ sourceChannel: "vellum" }).map((r) => r.id),
    ).toEqual(["inv3", "inv1"]);
    expect(store.listInvites({ contactId: "c1" }).map((r) => r.id)).toEqual([
      "inv2",
      "inv1",
    ]);
    expect(store.listInvites({ status: "active" }).length).toBe(3);

    // Combined filters.
    expect(
      store
        .listInvites({ sourceChannel: "vellum", contactId: "c1" })
        .map((r) => r.id),
    ).toEqual(["inv1"]);
  });

  test("listInvites honors limit and offset", () => {
    seedContact("c1");
    const store = new ContactStore();
    for (const id of ["inv1", "inv2", "inv3"]) {
      store.createInvite({
        id,
        sourceChannel: "vellum",
        inviteCodeHash: `h-${id}`,
        contactId: "c1",
        expiresAt: 9999,
      });
    }
    expect(store.listInvites({ limit: 2 }).map((r) => r.id)).toEqual([
      "inv3",
      "inv2",
    ]);
    expect(store.listInvites({ limit: 2, offset: 2 }).map((r) => r.id)).toEqual([
      "inv1",
    ]);
  });

  test("full lifecycle: create → redeem (maxUses=1) flips to redeemed → revoke is no-op", () => {
    seedContact("c1");
    const store = new ContactStore();
    store.createInvite({
      id: "inv1",
      sourceChannel: "vellum",
      inviteCodeHash: "h1",
      contactId: "c1",
      maxUses: 1,
      expiresAt: 9999,
    });

    const redeem = store.recordInviteRedemption({
      inviteId: "inv1",
      redeemedByExternalUserId: "u-ext",
      redeemedByExternalChatId: "chat-ext",
    });
    expect(redeem.updated).toBe(true);
    expect(redeem.row!.useCount).toBe(1);
    expect(redeem.row!.status).toBe("redeemed");
    expect(redeem.row!.redeemedByExternalUserId).toBe("u-ext");
    expect(redeem.row!.redeemedByExternalChatId).toBe("chat-ext");
    expect(redeem.row!.redeemedAt).not.toBeNull();

    // Revoking a redeemed (non-active) invite is a no-op but returns the row.
    const revoked = store.revokeInvite("inv1");
    expect(revoked).not.toBeNull();
    expect(revoked!.status).toBe("redeemed");
  });

  test("maxUses>1: status stays active until useCount reaches maxUses", () => {
    seedContact("c1");
    const store = new ContactStore();
    store.createInvite({
      id: "inv1",
      sourceChannel: "vellum",
      inviteCodeHash: "h1",
      contactId: "c1",
      maxUses: 2,
      expiresAt: 9999,
    });

    const r1 = store.recordInviteRedemption({ inviteId: "inv1" });
    expect(r1.updated).toBe(true);
    expect(r1.row!.useCount).toBe(1);
    expect(r1.row!.status).toBe("active");

    const r2 = store.recordInviteRedemption({ inviteId: "inv1" });
    expect(r2.updated).toBe(true);
    expect(r2.row!.useCount).toBe(2);
    expect(r2.row!.status).toBe("redeemed");

    // Exhausted (non-active) → further redemptions are gated out.
    const r3 = store.recordInviteRedemption({ inviteId: "inv1" });
    expect(r3.updated).toBe(false);
    expect(r3.row!.useCount).toBe(2);
    expect(r3.row!.status).toBe("redeemed");
  });

  test("revokeInvite flips active → revoked, is idempotent, and returns null for unknown id", () => {
    seedContact("c1");
    const store = new ContactStore();
    store.createInvite({
      id: "inv1",
      sourceChannel: "vellum",
      inviteCodeHash: "h1",
      contactId: "c1",
      expiresAt: 9999,
    });

    const revoked = store.revokeInvite("inv1");
    expect(revoked!.status).toBe("revoked");

    // Idempotent re-revoke returns the current (already revoked) row.
    const again = store.revokeInvite("inv1");
    expect(again!.status).toBe("revoked");

    // Unknown id → null.
    expect(store.revokeInvite("nope")).toBeNull();
  });

  test("status-gated redemption race: a revoked invite cannot be redeemed", () => {
    seedContact("c1");
    const store = new ContactStore();
    store.createInvite({
      id: "inv1",
      sourceChannel: "vellum",
      inviteCodeHash: "h1",
      contactId: "c1",
      maxUses: 5,
      expiresAt: 9999,
    });

    store.revokeInvite("inv1");

    const redeem = store.recordInviteRedemption({ inviteId: "inv1" });
    expect(redeem.updated).toBe(false);
    expect(redeem.row!.status).toBe("revoked");
    expect(redeem.row!.useCount).toBe(0);
  });

  test("recordInviteRedemption returns updated=false and null row for unknown id", () => {
    const redeem = new ContactStore().recordInviteRedemption({
      inviteId: "nope",
    });
    expect(redeem.updated).toBe(false);
    expect(redeem.row).toBeNull();
  });

  test("createInvite round-trips the widened secret + display columns", () => {
    seedContact("c1");
    const store = new ContactStore();

    const row = store.createInvite({
      id: "inv1",
      sourceChannel: "phone",
      contactId: "c1",
      expiresAt: 9999,
      tokenHash: "tok-hash",
      voiceCodeHash: "voice-hash",
      voiceCodeDigits: 6,
      expectedExternalUserId: "+15551234567",
      friendName: "Ada",
      guardianName: "Grace",
      sourceConversationId: "conv-42",
    });

    // No-code invites persist the NO_INVITE_CODE_HASH sentinel (see schema.ts).
    expect(row.inviteCodeHash).toBe("");
    expect(row.tokenHash).toBe("tok-hash");
    expect(row.voiceCodeHash).toBe("voice-hash");
    expect(row.voiceCodeDigits).toBe(6);
    expect(row.expectedExternalUserId).toBe("+15551234567");
    expect(row.friendName).toBe("Ada");
    expect(row.guardianName).toBe("Grace");
    expect(row.sourceConversationId).toBe("conv-42");

    // Persisted, not just echoed.
    expect(store.getInviteById("inv1")).toEqual(row);
  });

  test("createInvite defaults the widened columns to null", () => {
    seedContact("c1");
    const row = new ContactStore().createInvite({
      id: "inv1",
      sourceChannel: "vellum",
      inviteCodeHash: "h1",
      contactId: "c1",
      expiresAt: 9999,
    });
    expect(row.tokenHash).toBeNull();
    expect(row.voiceCodeHash).toBeNull();
    expect(row.voiceCodeDigits).toBeNull();
    expect(row.expectedExternalUserId).toBeNull();
    expect(row.friendName).toBeNull();
    expect(row.guardianName).toBeNull();
    expect(row.sourceConversationId).toBeNull();
  });

  test("findInviteByTokenHash matches regardless of status and returns null for unknown hash", () => {
    seedContact("c1");
    const store = new ContactStore();
    store.createInvite({
      id: "inv1",
      sourceChannel: "vellum",
      contactId: "c1",
      expiresAt: 9999,
      tokenHash: "tok-1",
    });

    expect(store.findInviteByTokenHash("tok-1")?.id).toBe("inv1");
    expect(store.findInviteByTokenHash("nope")).toBeNull();

    // Non-active rows are still findable (callers inspect status themselves).
    store.revokeInvite("inv1");
    expect(store.findInviteByTokenHash("tok-1")?.status).toBe("revoked");
  });

  test("findInviteByCodeHash is channel-scoped and active-only", () => {
    seedContact("c1");
    const store = new ContactStore();
    store.createInvite({
      id: "inv-sms",
      sourceChannel: "sms",
      inviteCodeHash: "code-1",
      contactId: "c1",
      expiresAt: 9999,
    });
    store.createInvite({
      id: "inv-tg",
      sourceChannel: "telegram",
      inviteCodeHash: "code-1",
      contactId: "c1",
      expiresAt: 9999,
    });

    // Same code hash on two channels → the channel scope disambiguates.
    expect(store.findInviteByCodeHash("code-1", "sms")?.id).toBe("inv-sms");
    expect(store.findInviteByCodeHash("code-1", "telegram")?.id).toBe("inv-tg");
    expect(store.findInviteByCodeHash("code-1", "vellum")).toBeNull();

    // Active-only: a revoked invite no longer matches.
    store.revokeInvite("inv-sms");
    expect(store.findInviteByCodeHash("code-1", "sms")).toBeNull();
  });

  test("code-hash lookups never match the no-code sentinel row", () => {
    seedContact("c1");
    const store = new ContactStore();
    // A voice invite persists inviteCodeHash="" (NO_INVITE_CODE_HASH).
    store.createInvite({
      id: "inv-voice",
      sourceChannel: "phone",
      contactId: "c1",
      expiresAt: Date.now() + 60_000,
      voiceCodeHash: "v1",
      expectedExternalUserId: "+15550001111",
    });

    expect(store.findInviteByCodeHash("", "phone")).toBeNull();
    expect(store.findInviteByCodeHashAnyChannel("")).toBeNull();
  });

  test("findInviteByCodeHashAnyChannel ignores channel but requires active + not-expired", () => {
    seedContact("c1");
    const store = new ContactStore();
    store.createInvite({
      id: "inv1",
      sourceChannel: "telegram",
      inviteCodeHash: "code-1",
      contactId: "c1",
      expiresAt: Date.now() + 60_000,
    });
    store.createInvite({
      id: "inv-expired",
      sourceChannel: "sms",
      inviteCodeHash: "code-old",
      contactId: "c1",
      expiresAt: Date.now() - 1,
    });

    // Cross-channel hit (the channel-mismatch messaging path).
    expect(store.findInviteByCodeHashAnyChannel("code-1")?.id).toBe("inv1");

    // Past-expiry rows don't match even while still status=active.
    expect(store.findInviteByCodeHashAnyChannel("code-old")).toBeNull();

    // Non-active rows don't match.
    store.revokeInvite("inv1");
    expect(store.findInviteByCodeHashAnyChannel("code-1")).toBeNull();
  });

  test("findActiveVoiceInvites lists active phone invites for the expected caller only", () => {
    seedContact("c1");
    const store = new ContactStore();
    store.createInvite({
      id: "inv-voice-1",
      sourceChannel: "phone",
      contactId: "c1",
      expiresAt: 9999,
      voiceCodeHash: "v1",
      expectedExternalUserId: "+15550001111",
    });
    store.createInvite({
      id: "inv-voice-2",
      sourceChannel: "phone",
      contactId: "c1",
      expiresAt: 9999,
      voiceCodeHash: "v2",
      expectedExternalUserId: "+15550001111",
    });
    // Different caller — excluded.
    store.createInvite({
      id: "inv-voice-other",
      sourceChannel: "phone",
      contactId: "c1",
      expiresAt: 9999,
      voiceCodeHash: "v3",
      expectedExternalUserId: "+15559998888",
    });
    // Non-phone channel with the same expected user — excluded.
    store.createInvite({
      id: "inv-sms",
      sourceChannel: "sms",
      inviteCodeHash: "h1",
      contactId: "c1",
      expiresAt: 9999,
      expectedExternalUserId: "+15550001111",
    });

    const found = store.findActiveVoiceInvites("+15550001111");
    expect(found.map((r) => r.id).sort()).toEqual([
      "inv-voice-1",
      "inv-voice-2",
    ]);

    // Non-active rows drop out.
    store.revokeInvite("inv-voice-1");
    expect(store.findActiveVoiceInvites("+15550001111").map((r) => r.id)).toEqual(
      ["inv-voice-2"],
    );
  });

  test("markInviteExpired flips active → expired once and gates redemption", () => {
    seedContact("c1");
    const store = new ContactStore();
    store.createInvite({
      id: "inv1",
      sourceChannel: "vellum",
      inviteCodeHash: "h1",
      contactId: "c1",
      expiresAt: 9999,
    });

    expect(store.markInviteExpired("inv1")).toBe(true);
    expect(store.getInviteById("inv1")?.status).toBe("expired");

    // No-op on non-active rows and unknown ids.
    expect(store.markInviteExpired("inv1")).toBe(false);
    expect(store.markInviteExpired("nope")).toBe(false);

    // recordInviteRedemption still gates on status='active'.
    const redeem = store.recordInviteRedemption({ inviteId: "inv1" });
    expect(redeem.updated).toBe(false);
    expect(redeem.row!.status).toBe("expired");
    expect(redeem.row!.useCount).toBe(0);
  });

  test("markInviteExpired does not flip a revoked invite", () => {
    seedContact("c1");
    const store = new ContactStore();
    store.createInvite({
      id: "inv1",
      sourceChannel: "vellum",
      inviteCodeHash: "h1",
      contactId: "c1",
      expiresAt: 9999,
    });
    store.revokeInvite("inv1");

    expect(store.markInviteExpired("inv1")).toBe(false);
    expect(store.getInviteById("inv1")?.status).toBe("revoked");
  });
});
