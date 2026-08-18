/**
 * End-to-end tests for the gateway text-verification intercept on the Telegram
 * guardian path: an outbound guardian session minted for the guardian's own
 * private chat, redeemed by a bare 6-digit code arriving from that chat.
 *
 * Runs against a real (temp-dir) gateway DB. Only the assistant-side IPC
 * boundary is mocked (identity mirror, contact-info reads, socket path).
 *
 * The two session shapes covered are the ones production mints for a
 * Telegram guardian:
 *
 * - `startOutboundTelegram` (`assistant channel-verification-sessions create
 *   --channel telegram --destination <chat id>`, also what the
 *   guardian-verify-setup skill runs): bound by `expectedChatId` only.
 * - the `/start` guardian-activation intercept: bound by both
 *   `expectedExternalUserId` and `expectedChatId`.
 *
 * Both must land the sender as the channel guardian on the SAME guardian
 * contact the platform bootstrapped on `vellum`, so the trust-verdict resolver
 * (the classifier the daemon's ACL stage consumes) flips the actor from
 * `unknown` to `guardian`. Every other test that references the intercept
 * mocks it; this file exercises the composition (parse → session lookup →
 * identity match → consume → guardian binding → reply) for real.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import "./test-preload.js";

// ---------------------------------------------------------------------------
// Assistant-side boundary mocks (must precede the dynamic imports below)
// ---------------------------------------------------------------------------

// Identity-mirror IPC: recorded and acked; the gateway DB stays the ACL
// source of truth in these tests.
const mirrorCalls: { method: string; params: unknown }[] = [];
const actualAssistantClient = await import("../ipc/assistant-client.js");
mock.module("../ipc/assistant-client.js", () => ({
  ...actualAssistantClient,
  ipcCallAssistant: async (method: string, params: unknown) => {
    mirrorCalls.push({ method, params });
    return {};
  },
}));

// Contact-info reads (daemon-backed): the guardian has no Telegram contact
// row yet, which is the state this flow exists to change.
mock.module("../ipc/contacts-info-client.js", () => ({
  lookupContactChannelIdentity: async () => null,
  probeContactMirror: async () => ({ exists: false, hasChannels: false }),
}));

// The assistant socket is absent (orphan-GC probes and similar short-circuit).
mock.module("../ipc/endpoint.js", () => ({
  resolveIpcSocketPath: () => ({
    path: "/nonexistent/assistant.sock",
    source: "test",
  }),
}));

const { getGatewayDb, initGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const {
  channelGuardianRateLimits,
  channelVerificationSessions,
  contactChannels,
  contacts,
} = await import("../db/schema.js");
const { createOutboundSession } =
  await import("../verification/session-service.js");
const { hasInterceptableSession } = await import("../db/session-store.js");
const { tryTextVerificationIntercept } =
  await import("../verification/text-verification.js");
const { resolveTrustVerdict } =
  await import("../risk/trust-verdict-resolver.js");
const { getRateLimit } = await import("../verification/rate-limit-helpers.js");

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

/** The guardian's Telegram user id; in a private chat the chat id is the same. */
const GUARDIAN_TG_ID = "700100";
/** Somebody else's private chat with the same bot. */
const STRANGER_TG_ID = "700200";
const VELLUM_PRINCIPAL = "vellum-principal-0000aaaa";
const VELLUM_ADDRESS = VELLUM_PRINCIPAL;

/**
 * Seed the platform-bootstrapped guardian: one guardian contact whose only
 * channel is the active `vellum` binding. This is what `contacts list` shows
 * on a fresh cloud assistant before any messaging channel is verified.
 */
function seedVellumGuardian(): { contactId: string } {
  const now = Date.now();
  const contactId = "c-guardian";
  const db = getGatewayDb();
  db.insert(contacts)
    .values({
      id: contactId,
      displayName: VELLUM_ADDRESS,
      role: "guardian",
      principalId: VELLUM_PRINCIPAL,
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
    })
    .run();
  db.insert(contactChannels)
    .values({
      id: "ch-guardian-vellum",
      contactId,
      type: "vellum",
      address: VELLUM_ADDRESS,
      externalChatId: VELLUM_ADDRESS,
      isPrimary: true,
      status: "active",
      policy: "allow",
      verifiedAt: now - 60_000,
      verifiedVia: "bootstrap",
      interactionCount: 0,
      createdAt: now - 60_000,
      updatedAt: now - 60_000,
    })
    .run();
  return { contactId };
}

/** The session `startOutboundTelegram` mints for a numeric chat-id destination. */
function mintDoctorStyleSession(chatId: string = GUARDIAN_TG_ID) {
  return createOutboundSession({
    channel: "telegram",
    expectedChatId: chatId,
    identityBindingStatus: "bound",
    destinationAddress: chatId,
    verificationPurpose: "guardian",
  });
}

/** The session the `/start` guardian-activation intercept mints. */
function mintActivationStyleSession(userId: string = GUARDIAN_TG_ID) {
  return createOutboundSession({
    channel: "telegram",
    expectedExternalUserId: userId,
    expectedChatId: userId,
    identityBindingStatus: "bound",
    destinationAddress: userId,
    verificationPurpose: "guardian",
  });
}

function guardianTelegramChannels() {
  return getGatewayDb()
    .select({
      contactId: contactChannels.contactId,
      address: contactChannels.address,
      externalChatId: contactChannels.externalChatId,
      status: contactChannels.status,
      policy: contactChannels.policy,
      verifiedVia: contactChannels.verifiedVia,
    })
    .from(contacts)
    .innerJoin(contactChannels, eq(contactChannels.contactId, contacts.id))
    .where(
      and(eq(contacts.role, "guardian"), eq(contactChannels.type, "telegram")),
    )
    .all();
}

function guardianContactCount(): number {
  return getGatewayDb()
    .select({ id: contacts.id })
    .from(contacts)
    .where(eq(contacts.role, "guardian"))
    .all().length;
}

function sessionRow(id: string) {
  return getGatewayDb()
    .select()
    .from(channelVerificationSessions)
    .where(eq(channelVerificationSessions.id, id))
    .get();
}

function interceptFromChat(chatId: string, messageContent: string) {
  return tryTextVerificationIntercept({
    sourceChannel: "telegram",
    messageContent,
    actorExternalUserId: chatId,
    actorChatId: chatId,
    actorDisplayName: "Sam Guardian",
    actorUsername: "samguardian",
    assistantId: "self",
  });
}

beforeEach(async () => {
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
});

// ---------------------------------------------------------------------------
// The guardian redeems the code from their own chat
// ---------------------------------------------------------------------------

describe("guardian redeems a Telegram code from the chat it was sent to", () => {
  const shapes = [
    {
      name: "chat-id-bound (channel-verification-sessions create)",
      mint: mintDoctorStyleSession,
    },
    {
      name: "user+chat-bound (/start guardian activation)",
      mint: mintActivationStyleSession,
    },
  ] as const;

  for (const shape of shapes) {
    test(`${shape.name}: binds the sender as guardian on the vellum guardian contact`, async () => {
      const { contactId } = seedVellumGuardian();
      const { sessionId, secret } = shape.mint();

      // Before: the sender is a stranger to the ACL.
      expect(
        (
          await resolveTrustVerdict({
            channelType: "telegram",
            actorExternalId: GUARDIAN_TG_ID,
          })
        ).trustClass,
      ).toBe("unknown");

      const result = await interceptFromChat(GUARDIAN_TG_ID, secret);

      expect(result).toEqual({
        intercepted: true,
        outcome: "verified",
        trustClass: "guardian",
        pendingReplyText:
          "Verification successful. You are now set as the guardian for this channel.",
      });

      // The session is spent, by this actor, and the channel has nothing left
      // to intercept, so the sender's next message is ordinary chat.
      const row = sessionRow(sessionId);
      expect(row?.status).toBe("consumed");
      expect(row?.consumedByExternalUserId).toBe(GUARDIAN_TG_ID);
      expect(row?.consumedByChatId).toBe(GUARDIAN_TG_ID);
      expect(hasInterceptableSession("telegram")).toBe(false);

      // One guardian contact, not a second one keyed on the Telegram id: the
      // binding attaches to the principal the vellum bootstrap established.
      expect(guardianContactCount()).toBe(1);
      expect(guardianTelegramChannels()).toEqual([
        {
          contactId,
          address: GUARDIAN_TG_ID,
          externalChatId: GUARDIAN_TG_ID,
          status: "active",
          policy: "allow",
          verifiedVia: "challenge",
        },
      ]);

      // After: the classifier the daemon's ACL stage consumes now admits the
      // sender as guardian, with delivery fields for outbound messages.
      const verdict = await resolveTrustVerdict({
        channelType: "telegram",
        actorExternalId: GUARDIAN_TG_ID,
      });
      expect(verdict.trustClass).toBe("guardian");
      expect(verdict.guardianPrincipalId).toBe(VELLUM_PRINCIPAL);
      expect(verdict.guardianExternalUserId).toBe(GUARDIAN_TG_ID);
      expect(verdict.guardianDeliveryChatId).toBe(GUARDIAN_TG_ID);

      // The identity mirror was asked to reflect the same contact + channel.
      const mirror = mirrorCalls.find(
        (c) => c.method === "contacts_mirror_apply",
      );
      expect(mirror).toBeDefined();
      const ops = (
        mirror!.params as { body: { ops: Record<string, unknown>[] } }
      ).body.ops;
      expect(ops).toHaveLength(1);
      expect(ops[0]).toMatchObject({
        op: "upsert_channel",
        contactId,
        type: "telegram",
        address: GUARDIAN_TG_ID,
        externalChatId: GUARDIAN_TG_ID,
      });
    });
  }
});

// ---------------------------------------------------------------------------
// The code is not a bearer token for the channel
// ---------------------------------------------------------------------------

describe("the code only works from the chat it was sent to", () => {
  test("a different chat presenting the right code gets the anti-oracle failure and no binding", async () => {
    seedVellumGuardian();
    const { sessionId, secret } = mintDoctorStyleSession(GUARDIAN_TG_ID);

    const result = await interceptFromChat(STRANGER_TG_ID, secret);

    expect(result).toEqual({
      intercepted: true,
      outcome: "failed",
      trustClass: "guardian",
      pendingReplyText: "The verification code is invalid or has expired.",
    });

    // The session survives for its rightful holder; the attempt is counted
    // against the stranger.
    expect(sessionRow(sessionId)?.status).toBe("awaiting_response");
    expect(
      JSON.parse(
        getRateLimit("telegram", STRANGER_TG_ID, STRANGER_TG_ID)
          ?.attemptTimestampsJson ?? "[]",
      ),
    ).toHaveLength(1);
    expect(guardianTelegramChannels()).toEqual([]);
    expect(
      (
        await resolveTrustVerdict({
          channelType: "telegram",
          actorExternalId: STRANGER_TG_ID,
        })
      ).trustClass,
    ).toBe("unknown");

    // …and the guardian can still redeem it.
    const redeem = await interceptFromChat(GUARDIAN_TG_ID, secret);
    expect(redeem.intercepted && redeem.outcome).toBe("verified");
    expect(guardianTelegramChannels()).toHaveLength(1);
  });

  test("a wrong code from the guardian's chat fails the same way and leaves the session live", async () => {
    seedVellumGuardian();
    const { sessionId, secret } = mintDoctorStyleSession();
    const wrong = secret === "000000" ? "111111" : "000000";

    const result = await interceptFromChat(GUARDIAN_TG_ID, wrong);

    expect(result).toEqual({
      intercepted: true,
      outcome: "failed",
      trustClass: "guardian",
      pendingReplyText: "The verification code is invalid or has expired.",
    });
    expect(sessionRow(sessionId)?.status).toBe("awaiting_response");
    expect(guardianTelegramChannels()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// Ordinary text is not a verification attempt
// ---------------------------------------------------------------------------

describe("non-code messages fall through to the runtime", () => {
  test("a plain reply while a session is live is not intercepted and does not touch the session", async () => {
    seedVellumGuardian();
    const { sessionId } = mintDoctorStyleSession();

    // "Ok" is what the ATL-1290 reporter typed after /start; the intercept
    // must leave it for the ACL stage rather than treating it as a code.
    const result = await interceptFromChat(GUARDIAN_TG_ID, "Ok");

    expect(result).toEqual({ intercepted: false });
    expect(sessionRow(sessionId)?.status).toBe("awaiting_response");
    expect(getRateLimit("telegram", GUARDIAN_TG_ID, GUARDIAN_TG_ID)).toBeNull();
    expect(guardianTelegramChannels()).toEqual([]);
  });
});
