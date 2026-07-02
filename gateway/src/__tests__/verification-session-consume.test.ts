/**
 * Tests for the gateway-native validate+consume path
 * (`validateAndConsumeSession`) and its in-engine role side effects.
 *
 * Runs against a real (temp-dir) gateway DB; only the assistant-side IPC
 * boundary is mocked (db proxy, identity mirror, contact-info reads).
 * Properties pinned here:
 *
 * - status-guarded single consume: a code is spendable exactly once, even
 *   under concurrent attempts, and never yields two bindings;
 * - anti-oracle failures: lockout, wrong code, expiry, identity mismatch,
 *   and blocked actors all return the same machine-readable reason;
 * - guardian phone binding happens synchronously at consume time, with the
 *   ATL-514 recency guard and deliberate-rebind semantics;
 * - trusted-contact consume upserts the verified channel idempotently and
 *   fails closed on a blocked authoritative gateway row.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { Database } from "bun:sqlite";
import { and, eq } from "drizzle-orm";

import "./test-preload.js";

// ---------------------------------------------------------------------------
// Assistant-side boundary mocks (must precede the dynamic imports below)
// ---------------------------------------------------------------------------

// db_proxy — backed by an in-process sqlite DB with the mirror tables the
// consume path touches (rate-limit dual-writes, trusted-contact mirror
// lookup).
let testAssistantDb: Database | null = null;

mock.module("../db/assistant-db-proxy.js", () => ({
  async assistantDbQuery(sql: string, bind?: unknown[]) {
    if (!testAssistantDb) throw new Error("test assistant DB not initialized");
    const stmt = testAssistantDb.prepare(sql);
     
    return bind ? stmt.all(...(bind as any[])) : stmt.all();
  },
  async assistantDbRun(sql: string, bind?: unknown[]) {
    if (!testAssistantDb) throw new Error("test assistant DB not initialized");
    const stmt = testAssistantDb.prepare(sql);
     
    const result = bind ? stmt.run(...(bind as any[])) : stmt.run();
    return {
      changes: result.changes,
      lastInsertRowid: Number(result.lastInsertRowid),
    };
  },
  async assistantDbExec(sql: string) {
    if (!testAssistantDb) throw new Error("test assistant DB not initialized");
    testAssistantDb.exec(sql);
  },
}));

// Identity-mirror IPC — recorded and acked; the gateway DB stays the ACL
// source of truth in these tests.
const mirrorCalls: { method: string; params: unknown }[] = [];
mock.module("../ipc/assistant-client.js", () => ({
  ipcCallAssistant: async (method: string, params: unknown) => {
    mirrorCalls.push({ method, params });
    return {};
  },
  IpcHandlerError: class IpcHandlerError extends Error {},
}));

// Contact-info reads (daemon-backed) — no known contacts by default.
mock.module("../ipc/contacts-info-client.js", () => ({
  lookupContactChannelIdentity: async () => null,
  probeContactMirror: async () => ({ exists: false, hasChannels: false }),
}));

// The assistant socket is absent (orphan-GC probes and similar short-circuit).
mock.module("../ipc/socket-path.js", () => ({
  resolveIpcSocketPath: () => ({
    path: "/nonexistent/assistant.sock",
    source: "test",
  }),
}));

const { getGatewayDb, initGatewayDb, resetGatewayDb } = await import(
  "../db/connection.js"
);
const {
  channelGuardianRateLimits,
  channelVerificationSessions,
  contactChannels,
  contacts,
} = await import("../db/schema.js");
const {
  VALIDATE_CONSUME_FAILURE_REASON,
  createOutboundSession,
  createPhoneGuardianBinding,
  validateAndConsumeSession,
} = await import("../verification/session-service.js");
const { consumeSession: storeConsumeSession } = await import(
  "../db/session-store.js"
);
const { getRateLimit } = await import("../verification/rate-limit-helpers.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const PHONE = "+15555550123";
const OTHER_PHONE = "+15555550199";
const OLD_GUARDIAN_PHONE = "+15555550100";

const GENERIC_FAILURE = {
  success: false,
  reason: VALIDATE_CONSUME_FAILURE_REASON,
} as const;

function seedAssistantMirrorTables(db: Database): void {
  db.exec(`
    CREATE TABLE contacts (
      id TEXT PRIMARY KEY,
      display_name TEXT NOT NULL,
      notes TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      role TEXT NOT NULL DEFAULT 'contact',
      principal_id TEXT,
      user_file TEXT,
      contact_type TEXT NOT NULL DEFAULT 'human'
    );
    CREATE TABLE contact_channels (
      id TEXT PRIMARY KEY,
      contact_id TEXT NOT NULL,
      type TEXT NOT NULL,
      address TEXT NOT NULL,
      is_primary INTEGER NOT NULL DEFAULT 0,
      external_user_id TEXT,
      external_chat_id TEXT,
      status TEXT NOT NULL DEFAULT 'unverified',
      policy TEXT NOT NULL DEFAULT 'allow',
      verified_at INTEGER,
      verified_via TEXT,
      created_at INTEGER NOT NULL,
      updated_at INTEGER
    );
    CREATE TABLE channel_guardian_rate_limits (
      id TEXT PRIMARY KEY,
      channel TEXT NOT NULL,
      actor_external_user_id TEXT NOT NULL,
      actor_chat_id TEXT NOT NULL,
      attempt_timestamps_json TEXT NOT NULL DEFAULT '[]',
      locked_until INTEGER,
      created_at INTEGER NOT NULL,
      updated_at INTEGER NOT NULL,
      UNIQUE (channel, actor_external_user_id, actor_chat_id)
    );
  `);
}

/** Seed a guardian contact + phone channel directly in the gateway DB. */
function seedGuardianPhoneBinding(opts: {
  contactId: string;
  address: string;
  status: "active" | "revoked";
  updatedAt: number;
}): void {
  const db = getGatewayDb();
  db.insert(contacts)
    .values({
      id: opts.contactId,
      displayName: `Guardian ${opts.contactId}`,
      role: "guardian",
      principalId: `principal-${opts.contactId}`,
      createdAt: opts.updatedAt - 60_000,
      updatedAt: opts.updatedAt,
    })
    .run();
  db.insert(contactChannels)
    .values({
      id: `ch-${opts.contactId}`,
      contactId: opts.contactId,
      type: "phone",
      address: opts.address,
      externalChatId: opts.address,
      isPrimary: true,
      status: opts.status,
      policy: "allow",
      interactionCount: 0,
      createdAt: opts.updatedAt - 60_000,
      updatedAt: opts.updatedAt,
    })
    .run();
}

function guardianPhoneBindings(): { address: string; status: string }[] {
  return getGatewayDb()
    .select({
      address: contactChannels.address,
      status: contactChannels.status,
    })
    .from(contacts)
    .innerJoin(contactChannels, eq(contactChannels.contactId, contacts.id))
    .where(
      and(eq(contacts.role, "guardian"), eq(contactChannels.type, "phone")),
    )
    .all();
}

function activeGuardianPhoneBindings(): { address: string }[] {
  return guardianPhoneBindings()
    .filter((b) => b.status === "active")
    .map((b) => ({ address: b.address }));
}

function sessionRow(id: string) {
  return getGatewayDb()
    .select()
    .from(channelVerificationSessions)
    .where(eq(channelVerificationSessions.id, id))
    .get();
}

function createPhoneGuardianSession(phone: string = PHONE) {
  return createOutboundSession({
    channel: "phone",
    expectedPhoneE164: phone,
    destinationAddress: phone,
    verificationPurpose: "guardian",
  });
}

function createPhoneTrustedContactSession(phone: string = PHONE) {
  return createOutboundSession({
    channel: "phone",
    expectedPhoneE164: phone,
    destinationAddress: phone,
    verificationPurpose: "trusted_contact",
  });
}

beforeEach(async () => {
  testAssistantDb = new Database(":memory:");
  seedAssistantMirrorTables(testAssistantDb);
  mirrorCalls.length = 0;

  resetGatewayDb();
  await initGatewayDb();
  const db = getGatewayDb();
  db.delete(channelVerificationSessions).run();
  db.delete(channelGuardianRateLimits).run();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
});

afterEach(() => {
  resetGatewayDb();
  testAssistantDb?.close();
  testAssistantDb = null;
});

// ---------------------------------------------------------------------------
// Guardian (outbound voice shape) — binding at consume time
// ---------------------------------------------------------------------------

describe("guardian consume — synchronous phone binding", () => {
  test("success consumes the session and creates the binding with no polling dependency", async () => {
    const { sessionId, secret } = createPhoneGuardianSession();

    const result = await validateAndConsumeSession(
      "phone",
      secret,
      PHONE,
      PHONE,
    );
    expect(result).toEqual({ success: true, verificationType: "guardian" });

    const row = sessionRow(sessionId);
    expect(row?.status).toBe("consumed");
    expect(row?.consumedByExternalUserId).toBe(PHONE);
    expect(row?.consumedByChatId).toBe(PHONE);

    // The binding exists immediately after the call returns — applied
    // in-engine, synchronously.
    expect(activeGuardianPhoneBindings()).toEqual([{ address: PHONE }]);
  });

  test("replayed secret fails closed and never yields a second binding", async () => {
    const { secret } = createPhoneGuardianSession();

    expect(
      (await validateAndConsumeSession("phone", secret, PHONE, PHONE)).success,
    ).toBe(true);

    // IPC re-delivery of the same consume: the status guard makes the
    // session unmatchable, so the retry fails with the generic reason.
    const replay = await validateAndConsumeSession(
      "phone",
      secret,
      PHONE,
      PHONE,
    );
    expect(replay).toEqual(GENERIC_FAILURE);

    // Re-running the side effect directly is also idempotent (binding for
    // the same number already exists → skip).
    await createPhoneGuardianBinding(PHONE, PHONE, Date.now());

    expect(guardianPhoneBindings()).toEqual([
      { address: PHONE, status: "active" },
    ]);
  });

  test("concurrent consume: exactly one winner, exactly one binding", async () => {
    const { secret } = createPhoneGuardianSession();

    const results = await Promise.all([
      validateAndConsumeSession("phone", secret, PHONE, PHONE),
      validateAndConsumeSession("phone", secret, PHONE, PHONE),
    ]);

    expect(results.filter((r) => r.success)).toHaveLength(1);
    expect(activeGuardianPhoneBindings()).toEqual([{ address: PHONE }]);
  });

  test("deliberate rebind: revokes a conflicting guardian binding for another number", async () => {
    seedGuardianPhoneBinding({
      contactId: "c-old",
      address: OLD_GUARDIAN_PHONE,
      status: "active",
      updatedAt: Date.now() - 60_000,
    });

    const { secret } = createPhoneGuardianSession(PHONE);
    const result = await validateAndConsumeSession(
      "phone",
      secret,
      PHONE,
      PHONE,
    );
    expect(result.success).toBe(true);

    // Outbound verification is guardian-initiated, so the conflicting old
    // binding is revoked rather than skipped (unlike the inbound path).
    const bindings = guardianPhoneBindings();
    expect(bindings).toContainEqual({
      address: OLD_GUARDIAN_PHONE,
      status: "revoked",
    });
    expect(activeGuardianPhoneBindings()).toEqual([{ address: PHONE }]);
  });

  test("ATL-514: a binding event newer than the consume blocks the (stale) binding", async () => {
    // A guardian binding for this number was revoked AFTER this session will
    // be consumed (clock-skewed future timestamp models the IPC-retry
    // replay shape). The consume itself succeeds — the session is
    // legitimately spent — but the stale side effect must not reactivate the
    // revoked binding.
    seedGuardianPhoneBinding({
      contactId: "c-revoked",
      address: PHONE,
      status: "revoked",
      updatedAt: Date.now() + 60_000,
    });

    const { secret } = createPhoneGuardianSession(PHONE);
    const result = await validateAndConsumeSession(
      "phone",
      secret,
      PHONE,
      PHONE,
    );
    expect(result.success).toBe(true);

    expect(activeGuardianPhoneBindings()).toEqual([]);
    expect(guardianPhoneBindings()).toEqual([
      { address: PHONE, status: "revoked" },
    ]);
  });

  test("ATL-514 anchor: the recency guard uses the persisted consume timestamp", async () => {
    const { sessionId } = createPhoneGuardianSession(PHONE);

    const result = storeConsumeSession(sessionId, PHONE, PHONE);
    if (!result.consumed) throw new Error("expected consume to succeed");

    // The returned timestamp is exactly the row's persisted updated_at.
    expect(result.consumedAt).toBe(sessionRow(sessionId)!.updatedAt);

    // A guardian revoke lands after the consume was persisted but before the
    // binding side effect runs (IPC retry / replay shape). Anchored on the
    // persisted timestamp the stale binding is rejected; a re-sampled clock
    // would have looked newer than the revoke and rebound.
    seedGuardianPhoneBinding({
      contactId: "c-newer-revoke",
      address: PHONE,
      status: "revoked",
      updatedAt: result.consumedAt + 1,
    });
    await createPhoneGuardianBinding(PHONE, PHONE, result.consumedAt);

    expect(activeGuardianPhoneBindings()).toEqual([]);
  });

  test("blocked actor: correct code fails closed, existing guardian is not revoked", async () => {
    seedGuardianPhoneBinding({
      contactId: "c-current",
      address: OLD_GUARDIAN_PHONE,
      status: "active",
      updatedAt: Date.now() - 60_000,
    });

    const now = Date.now();
    getGatewayDb()
      .insert(contacts)
      .values({
        id: "c-blocked",
        displayName: "Blocked",
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    getGatewayDb()
      .insert(contactChannels)
      .values({
        id: "ch-blocked",
        contactId: "c-blocked",
        type: "phone",
        address: PHONE,
        isPrimary: false,
        status: "blocked",
        policy: "deny",
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const { sessionId, secret } = createPhoneGuardianSession(PHONE);
    const result = await validateAndConsumeSession(
      "phone",
      secret,
      PHONE,
      PHONE,
    );

    // Same generic failure (anti-oracle), the one-time code is spent, the
    // current guardian keeps the binding, and no binding is created for the
    // blocked number.
    expect(result).toEqual(GENERIC_FAILURE);
    expect(sessionRow(sessionId)?.status).toBe("consumed");
    expect(activeGuardianPhoneBindings()).toEqual([
      { address: OLD_GUARDIAN_PHONE },
    ]);
    const channel = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch-blocked"))
      .get();
    expect(channel?.status).toBe("blocked");
    expect(channel?.policy).toBe("deny");
  });

  test("guardian consume on a non-phone channel applies no side effect", async () => {
    const { sessionId, secret } = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "tg-user-1",
      expectedChatId: "tg-chat-1",
      verificationPurpose: "guardian",
    });

    const result = await validateAndConsumeSession(
      "telegram",
      secret,
      "tg-user-1",
      "tg-chat-1",
    );
    expect(result).toEqual({ success: true, verificationType: "guardian" });
    expect(sessionRow(sessionId)?.status).toBe("consumed");
    expect(guardianPhoneBindings()).toEqual([]);
    expect(mirrorCalls).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Rate limiting + anti-oracle failures
// ---------------------------------------------------------------------------

describe("rate limiting and anti-oracle failures", () => {
  test("wrong code: generic failure, attempt recorded, session stays consumable", async () => {
    const { sessionId, secret } = createPhoneGuardianSession();

    const bad = await validateAndConsumeSession(
      "phone",
      "000000",
      PHONE,
      PHONE,
    );
    expect(bad).toEqual(GENERIC_FAILURE);

    const rl = getRateLimit("phone", PHONE, PHONE);
    expect(JSON.parse(rl?.attemptTimestampsJson ?? "[]")).toHaveLength(1);
    expect(rl?.lockedUntil).toBeNull();
    expect(sessionRow(sessionId)?.status).toBe("awaiting_response");

    // Success afterwards resets the counter.
    const ok = await validateAndConsumeSession("phone", secret, PHONE, PHONE);
    expect(ok.success).toBe(true);
    const reset = getRateLimit("phone", PHONE, PHONE);
    expect(JSON.parse(reset?.attemptTimestampsJson ?? "[]")).toHaveLength(0);
    expect(reset?.lockedUntil).toBeNull();
  });

  test("lockout after 5 invalid attempts: even the correct code fails while locked", async () => {
    const { sessionId, secret } = createPhoneGuardianSession();

    for (let i = 0; i < 5; i++) {
      const res = await validateAndConsumeSession(
        "phone",
        "000000",
        PHONE,
        PHONE,
      );
      expect(res).toEqual(GENERIC_FAILURE);
    }

    const rl = getRateLimit("phone", PHONE, PHONE);
    expect(rl?.lockedUntil).toBeGreaterThan(Date.now());

    const locked = await validateAndConsumeSession(
      "phone",
      secret,
      PHONE,
      PHONE,
    );
    expect(locked).toEqual(GENERIC_FAILURE);
    expect(sessionRow(sessionId)?.status).toBe("awaiting_response");
    expect(activeGuardianPhoneBindings()).toEqual([]);
  });

  test("identity mismatch: same generic failure as a wrong code, attempt recorded", async () => {
    const { sessionId, secret } = createPhoneGuardianSession(PHONE);

    const res = await validateAndConsumeSession(
      "phone",
      secret,
      OTHER_PHONE,
      OTHER_PHONE,
    );
    // Anti-oracle: indistinguishable from a wrong code.
    expect(res).toEqual(GENERIC_FAILURE);

    const rl = getRateLimit("phone", OTHER_PHONE, OTHER_PHONE);
    expect(JSON.parse(rl?.attemptTimestampsJson ?? "[]")).toHaveLength(1);
    expect(sessionRow(sessionId)?.status).toBe("awaiting_response");
    expect(activeGuardianPhoneBindings()).toEqual([]);
  });

  test("expired session: generic failure, attempt recorded", async () => {
    const { sessionId, secret } = createPhoneGuardianSession();
    getGatewayDb()
      .update(channelVerificationSessions)
      .set({ expiresAt: Date.now() - 1_000 })
      .where(eq(channelVerificationSessions.id, sessionId))
      .run();

    const res = await validateAndConsumeSession("phone", secret, PHONE, PHONE);
    expect(res).toEqual(GENERIC_FAILURE);
    const rl = getRateLimit("phone", PHONE, PHONE);
    expect(JSON.parse(rl?.attemptTimestampsJson ?? "[]")).toHaveLength(1);
    expect(sessionRow(sessionId)?.status).toBe("awaiting_response");
  });
});

// ---------------------------------------------------------------------------
// Trusted contact — verified channel upsert
// ---------------------------------------------------------------------------

describe("trusted-contact consume — verified channel upsert", () => {
  test("success upserts the verified gateway channel (no guardian binding)", async () => {
    const { sessionId, secret } = createPhoneTrustedContactSession();

    const result = await validateAndConsumeSession(
      "phone",
      secret,
      PHONE,
      PHONE,
    );
    expect(result).toEqual({
      success: true,
      verificationType: "trusted_contact",
    });
    expect(sessionRow(sessionId)?.status).toBe("consumed");

    const channel = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.type, "phone"),
          eq(contactChannels.address, PHONE),
        ),
      )
      .get();
    expect(channel?.status).toBe("active");
    expect(channel?.policy).toBe("allow");
    expect(channel?.verifiedVia).toBe("challenge");

    const contact = getGatewayDb()
      .select()
      .from(contacts)
      .where(eq(contacts.id, channel!.contactId))
      .get();
    expect(contact?.role).toBe("contact");
    expect(guardianPhoneBindings()).toEqual([]);

    // The identity mirror was told about the channel (ACL stays gateway-side).
    expect(
      mirrorCalls.some((c) => c.method === "contacts_mirror_upsert_channel"),
    ).toBe(true);
  });

  test("re-verification is idempotent: one (type,address) channel row", async () => {
    const first = createPhoneTrustedContactSession();
    expect(
      (await validateAndConsumeSession("phone", first.secret, PHONE, PHONE))
        .success,
    ).toBe(true);

    const second = createPhoneTrustedContactSession();
    expect(
      (await validateAndConsumeSession("phone", second.secret, PHONE, PHONE))
        .success,
    ).toBe(true);

    const rows = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(
        and(
          eq(contactChannels.type, "phone"),
          eq(contactChannels.address, PHONE),
        ),
      )
      .all();
    expect(rows).toHaveLength(1);
    expect(rows[0].status).toBe("active");
  });

  test("blocked actor: correct code fails closed, channel stays blocked", async () => {
    const now = Date.now();
    getGatewayDb()
      .insert(contacts)
      .values({
        id: "c-blocked",
        displayName: "Blocked",
        role: "contact",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    getGatewayDb()
      .insert(contactChannels)
      .values({
        id: "ch-blocked",
        contactId: "c-blocked",
        type: "phone",
        address: PHONE,
        isPrimary: false,
        status: "blocked",
        policy: "deny",
        interactionCount: 0,
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const { sessionId, secret } = createPhoneTrustedContactSession();
    const result = await validateAndConsumeSession(
      "phone",
      secret,
      PHONE,
      PHONE,
    );

    // Same generic failure (anti-oracle), the one-time code is spent, and
    // the authoritative blocked row is untouched.
    expect(result).toEqual(GENERIC_FAILURE);
    expect(sessionRow(sessionId)?.status).toBe("consumed");
    const channel = getGatewayDb()
      .select()
      .from(contactChannels)
      .where(eq(contactChannels.id, "ch-blocked"))
      .get();
    expect(channel?.status).toBe("blocked");
    expect(channel?.policy).toBe("deny");
  });
});
