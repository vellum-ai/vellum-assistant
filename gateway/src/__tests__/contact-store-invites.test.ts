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
});
