/**
 * InviteStore.mirrorCreate — unit tests against the real bun-sqlite
 * gateway DB.
 *
 * Track B PR-B-1: the daemon owns invite creation; the gateway holds a
 * mirror row. These tests prove the mirror is idempotent on `id` (so a
 * daemon retry after a transient mirror failure converges to the right
 * state) and that voice + non-voice + invite-code shapes round-trip
 * cleanly.
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

import { eq } from "drizzle-orm";

import {
  initGatewayDb,
  getGatewayDb,
  resetGatewayDb,
} from "../db/connection.js";
import { InviteStore } from "../db/invite-store.js";
import { contacts, ingressInvites } from "../db/schema.js";

const CONTACT_ID = "co-invite-test";

function baseInvite(overrides: Partial<typeof ingressInvites.$inferInsert> = {}) {
  const now = Date.now();
  return {
    id: "inv-1",
    sourceChannel: "telegram",
    tokenHash: "tok-hash-1",
    sourceConversationId: null,
    note: null,
    maxUses: 1,
    useCount: 0,
    expiresAt: now + 60_000,
    status: "active" as const,
    redeemedByExternalUserId: null,
    redeemedByExternalChatId: null,
    redeemedAt: null,
    expectedExternalUserId: null,
    voiceCodeHash: null,
    voiceCodeDigits: null,
    inviteCodeHash: null,
    friendName: null,
    guardianName: null,
    contactId: CONTACT_ID,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

beforeAll(async () => {
  await initGatewayDb();
});

beforeEach(() => {
  const db = getGatewayDb();
  db.delete(ingressInvites).run();
  db.delete(contacts).run();
  const now = Date.now();
  db.insert(contacts)
    .values({
      id: CONTACT_ID,
      displayName: "Test Contact",
      role: "contact",
      principalId: null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
});

afterAll(() => {
  resetGatewayDb();
});

describe("InviteStore.mirrorCreate", () => {
  test("inserts a new mirror row when none exists", () => {
    const store = new InviteStore(getGatewayDb());
    const row = store.mirrorCreate(baseInvite());

    expect(row.id).toBe("inv-1");
    expect(row.sourceChannel).toBe("telegram");
    expect(row.tokenHash).toBe("tok-hash-1");
    expect(row.contactId).toBe(CONTACT_ID);
    expect(row.maxUses).toBe(1);
    expect(row.useCount).toBe(0);
    expect(row.status).toBe("active");
  });

  test("is idempotent on id — second call updates existing row", () => {
    const store = new InviteStore(getGatewayDb());
    store.mirrorCreate(baseInvite({ useCount: 0 }));

    const updated = store.mirrorCreate(
      baseInvite({
        useCount: 1,
        status: "redeemed",
        redeemedByExternalUserId: "ext-user-99",
        redeemedAt: 12345,
      }),
    );

    expect(updated.useCount).toBe(1);
    expect(updated.status).toBe("redeemed");
    expect(updated.redeemedByExternalUserId).toBe("ext-user-99");
    expect(updated.redeemedAt).toBe(12345);

    const all = getGatewayDb()
      .select()
      .from(ingressInvites)
      .where(eq(ingressInvites.id, "inv-1"))
      .all();
    expect(all).toHaveLength(1);
  });

  test("round-trips a voice-invite shape", () => {
    const store = new InviteStore(getGatewayDb());
    const row = store.mirrorCreate(
      baseInvite({
        id: "inv-voice",
        sourceChannel: "phone",
        expectedExternalUserId: "+15551234567",
        voiceCodeHash: "voice-h",
        voiceCodeDigits: 6,
        friendName: "Alice",
        guardianName: "Bob",
      }),
    );

    expect(row.sourceChannel).toBe("phone");
    expect(row.expectedExternalUserId).toBe("+15551234567");
    expect(row.voiceCodeHash).toBe("voice-h");
    expect(row.voiceCodeDigits).toBe(6);
    expect(row.friendName).toBe("Alice");
    expect(row.guardianName).toBe("Bob");
    expect(row.inviteCodeHash).toBeNull();
  });

  test("round-trips a non-voice invite-code shape", () => {
    const store = new InviteStore(getGatewayDb());
    const row = store.mirrorCreate(
      baseInvite({
        id: "inv-code",
        sourceChannel: "slack",
        inviteCodeHash: "code-h",
      }),
    );

    expect(row.sourceChannel).toBe("slack");
    expect(row.inviteCodeHash).toBe("code-h");
    expect(row.voiceCodeHash).toBeNull();
    expect(row.expectedExternalUserId).toBeNull();
  });

  test("getInvite returns the stored row by id, or undefined", () => {
    const store = new InviteStore(getGatewayDb());
    store.mirrorCreate(baseInvite({ id: "inv-fetch" }));

    const found = store.getInvite("inv-fetch");
    expect(found?.id).toBe("inv-fetch");

    expect(store.getInvite("nonexistent")).toBeUndefined();
  });

  test("uses the injected db instance instead of the global", () => {
    const db = getGatewayDb();
    const store = new InviteStore(db);
    store.mirrorCreate(baseInvite({ id: "inv-inject" }));

    // Direct query through the injected db sees the same row.
    const row = db
      .select()
      .from(ingressInvites)
      .where(eq(ingressInvites.id, "inv-inject"))
      .get();
    expect(row?.id).toBe("inv-inject");
  });
});
