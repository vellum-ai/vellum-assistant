/**
 * Tests for `decideGuardianRequest` — the atomic decision CAS + in-engine ACL
 * outcomes (ATL-463).
 *
 * Runs against a real (temp-dir) gateway DB; only the assistant-side IPC
 * boundary is mocked (identity-mirror reads and writes). Properties pinned:
 *
 * - each ACL outcome (verified-channel activation, unverified seed, block,
 *   outbound-session mint) commits in the SAME transaction as the
 *   pending→approved/denied CAS — one call, both rows;
 * - a CAS miss returns status_conflict with ZERO side effects, so replayed
 *   or racing decides never double-apply an outcome;
 * - THE ATL-463 PIN: a failed outcome write rolls the CAS back — the request
 *   stays `pending` with no partial ACL write, and a retry decide succeeds.
 *   The crash window between "row says approved" and "ACL write landed"
 *   cannot exist because the two are one commit;
 * - daemon-domain kinds decide as a plain CAS (no outcome, no ACL writes);
 * - post-commit assistant mirrors are best-effort: their failure never
 *   disturbs the committed decision.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { and, eq } from "drizzle-orm";

import { hashVerificationSecret } from "@vellumai/gateway-client";
import type { DecideGuardianRequestIpcParams } from "@vellumai/gateway-client";

import "./test-preload.js";

// ---------------------------------------------------------------------------
// Assistant-side boundary mocks (must precede the dynamic imports below)
// ---------------------------------------------------------------------------

// Identity-mirror IPC — recorded and acked; a flag turns it into a thrower to
// model an unreachable daemon mirror.
const mirrorCalls: { method: string; body: Record<string, unknown> }[] = [];
let mirrorThrow = false;
mock.module("../ipc/assistant-client.js", () => ({
  IpcHandlerError: class IpcHandlerError extends Error {},
  IpcTransportError: class IpcTransportError extends Error {},
  ipcCallAssistant: async (
    method: string,
    params?: { body?: Record<string, unknown> },
  ) => {
    mirrorCalls.push({ method, body: params?.body ?? {} });
    if (mirrorThrow) {
      throw new Error(`assistant mirror unreachable: ${method}`);
    }
    return { ok: true };
  },
}));

// Contact-info reads (daemon-backed) — no known mirror contacts by default;
// the lookup impl is mutable so a test can induce an assistant-IPC failure.
let lookupImpl: () => Promise<null> = async () => null;
mock.module("../ipc/contacts-info-client.js", () => ({
  lookupContactChannelIdentity: () => lookupImpl(),
  probeContactMirror: async () => ({ exists: false, hasChannels: false }),
  fetchContactsInfoBatch: async () => [],
  listContactUserFileSlugs: async () => [],
}));

const { getGatewayDb, initGatewayDb, resetGatewayDb } =
  await import("../db/connection.js");
const {
  channelVerificationSessions,
  contactChannels,
  contacts,
  guardianRequestDeliveries,
  guardianRequests,
} = await import("../db/schema.js");
const { createGuardianRequest } = await import("../db/guardian-request-store.js");
const { decideGuardianRequest } = await import(
  "../approvals/guardian-request-service.js"
);
const { createOutboundSession } = await import(
  "../verification/session-service.js"
);

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const CHANNEL = "telegram";
const SENDER = "tg-sender-1";
const SENDER_CHAT = "chat-100";

let reqSeq = 0;

function seedRequest(overrides: Record<string, unknown> = {}) {
  return createGuardianRequest({
    id: `req-${++reqSeq}`,
    kind: "access_request",
    sourceChannel: CHANNEL,
    requesterExternalUserId: SENDER,
    requesterChatId: SENDER_CHAT,
    guardianPrincipalId: "principal-1",
    ...overrides,
  });
}

function requestRow(id: string) {
  return getGatewayDb()
    .select()
    .from(guardianRequests)
    .where(eq(guardianRequests.id, id))
    .get();
}

function channelRows(address = SENDER) {
  return getGatewayDb()
    .select()
    .from(contactChannels)
    .where(
      and(
        eq(contactChannels.type, CHANNEL),
        eq(contactChannels.address, address),
      ),
    )
    .all();
}

function sessionRows() {
  return getGatewayDb().select().from(channelVerificationSessions).all();
}

function seedGatewayChannel(status: string, opts: { role?: string } = {}) {
  const db = getGatewayDb();
  const now = Date.now();
  db.insert(contacts)
    .values({
      id: "co-seeded",
      displayName: "Seeded",
      role: opts.role ?? "contact",
      createdAt: now,
      updatedAt: now,
    })
    .run();
  db.insert(contactChannels)
    .values({
      id: "ch-seeded",
      contactId: "co-seeded",
      type: CHANNEL,
      address: SENDER,
      isPrimary: false,
      status,
      policy: "allow",
      interactionCount: 0,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function activateDecision(
  requestId: string,
  overrides: Partial<DecideGuardianRequestIpcParams> = {},
): DecideGuardianRequestIpcParams {
  return {
    id: requestId,
    expectedStatus: "pending",
    status: "approved",
    decidedByPrincipalId: "principal-1",
    aclOutcome: {
      type: "activate_member",
      sourceChannel: CHANNEL,
      externalUserId: SENDER,
      externalChatId: SENDER_CHAT,
      displayName: "Alice",
      verifiedVia: "manual_channel_claim",
    },
    ...overrides,
  };
}

beforeEach(async () => {
  mirrorCalls.length = 0;
  mirrorThrow = false;
  lookupImpl = async () => null;

  resetGatewayDb();
  await initGatewayDb();
  const db = getGatewayDb();
  db.delete(guardianRequestDeliveries).run();
  db.delete(guardianRequests).run();
  db.delete(channelVerificationSessions).run();
  db.delete(contactChannels).run();
  db.delete(contacts).run();
});

afterEach(() => {
  resetGatewayDb();
});

// ---------------------------------------------------------------------------
// Per-outcome success: CAS + ACL write in one call
// ---------------------------------------------------------------------------

describe("decide — per-outcome success", () => {
  test("approve + activate_member: request approved AND channel verified in one call", async () => {
    const request = seedRequest();

    const result = await decideGuardianRequest(activateDecision(request.id));

    expect(result.applied).toBe(true);
    if (result.applied) {
      expect(result.request.status).toBe("approved");
      expect(result.request.decidedByPrincipalId).toBe("principal-1");
      expect(result.mintedSession).toBeUndefined();
    }
    expect(requestRow(request.id)?.status).toBe("approved");

    const channels = channelRows();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      status: "active",
      policy: "allow",
      verifiedVia: "manual_channel_claim",
      externalChatId: SENDER_CHAT,
    });
    expect(channels[0]!.verifiedAt).toEqual(expect.any(Number));

    // Post-commit identity mirror fired (identity/info only).
    const upserts = mirrorCalls.filter(
      (c) => c.method === "contacts_mirror_upsert_channel",
    );
    expect(upserts).toHaveLength(1);
    expect(upserts[0]!.body).toMatchObject({
      type: CHANNEL,
      address: SENDER,
      displayName: "Alice",
    });
    expect(upserts[0]!.body.status).toBeUndefined();
  });

  test("deny + seed_unverified: request denied AND sender seeded as an unverified contact", async () => {
    const request = seedRequest();

    const result = await decideGuardianRequest({
      id: request.id,
      expectedStatus: "pending",
      status: "denied",
      decidedByPrincipalId: "principal-1",
      aclOutcome: {
        type: "seed_unverified",
        sourceChannel: CHANNEL,
        externalUserId: SENDER,
        displayName: "Alice",
      },
    });

    expect(result.applied).toBe(true);
    expect(requestRow(request.id)?.status).toBe("denied");

    const channels = channelRows();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ status: "unverified", policy: "allow" });

    const contact = getGatewayDb()
      .select()
      .from(contacts)
      .where(eq(contacts.id, channels[0]!.contactId))
      .get();
    expect(contact).toMatchObject({ displayName: "Alice", role: "contact" });

    // Post-commit full-contact mirror fired.
    expect(
      mirrorCalls.filter((c) => c.method === "contacts_mirror_upsert_full"),
    ).toHaveLength(1);
  });

  test("deny + block: request denied AND channel revoked with the audit reason", async () => {
    const request = seedRequest();

    const result = await decideGuardianRequest({
      id: request.id,
      expectedStatus: "pending",
      status: "denied",
      aclOutcome: {
        type: "block",
        sourceChannel: CHANNEL,
        externalUserId: SENDER,
        reason: "introduction_block",
      },
    });

    expect(result.applied).toBe(true);
    expect(requestRow(request.id)?.status).toBe("denied");

    const channels = channelRows();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({
      status: "revoked",
      revokedReason: "introduction_block",
    });
  });

  test("deny + block over an existing seeded channel revokes it in place", async () => {
    seedGatewayChannel("unverified");
    const request = seedRequest();

    const result = await decideGuardianRequest({
      id: request.id,
      expectedStatus: "pending",
      status: "denied",
      aclOutcome: {
        type: "block",
        sourceChannel: CHANNEL,
        externalUserId: SENDER,
        reason: "introduction_block",
      },
    });

    expect(result.applied).toBe(true);
    const channels = channelRows();
    expect(channels).toHaveLength(1);
    expect(channels[0]).toMatchObject({ id: "ch-seeded", status: "revoked" });
  });

  test("approve + mint_outbound_session: session row exists and the response carries the secret", async () => {
    const request = seedRequest();

    const result = await decideGuardianRequest({
      id: request.id,
      expectedStatus: "pending",
      status: "approved",
      aclOutcome: {
        type: "mint_outbound_session",
        channel: CHANNEL,
        expectedExternalUserId: SENDER,
        expectedChatId: SENDER_CHAT,
        identityBindingStatus: "bound",
        destinationAddress: SENDER_CHAT,
        verificationPurpose: "trusted_contact",
      },
    });

    expect(result.applied).toBe(true);
    if (!result.applied) return;
    expect(requestRow(request.id)?.status).toBe("approved");

    const minted = result.mintedSession!;
    expect(minted.secret).toMatch(/^\d{6}$/);

    const sessions = sessionRows();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]).toMatchObject({
      id: minted.sessionId,
      channel: CHANNEL,
      status: "awaiting_response",
      expectedExternalUserId: SENDER,
      challengeHash: hashVerificationSecret(minted.secret),
      verificationPurpose: "trusted_contact",
    });
  });
});

// ---------------------------------------------------------------------------
// CAS miss / idempotency
// ---------------------------------------------------------------------------

describe("decide — CAS conflict semantics", () => {
  test("a pre-decided request returns status_conflict with ZERO ACL writes", async () => {
    const request = seedRequest({ status: "denied" });

    const result = await decideGuardianRequest(activateDecision(request.id));

    expect(result).toEqual({ applied: false, reason: "status_conflict" });
    expect(requestRow(request.id)?.status).toBe("denied");
    expect(channelRows()).toHaveLength(0);
    expect(sessionRows()).toHaveLength(0);
    expect(mirrorCalls).toHaveLength(0);
  });

  test("idempotent re-delivery: a retried decide after success conflicts and never double-applies", async () => {
    const request = seedRequest();

    const first = await decideGuardianRequest(activateDecision(request.id));
    expect(first.applied).toBe(true);
    const verifiedAt = channelRows()[0]!.verifiedAt;

    const replay = await decideGuardianRequest(activateDecision(request.id));
    expect(replay).toEqual({ applied: false, reason: "status_conflict" });

    // One channel row, untouched by the replay; one mirror upsert total.
    const channels = channelRows();
    expect(channels).toHaveLength(1);
    expect(channels[0]!.verifiedAt).toBe(verifiedAt);
    expect(
      mirrorCalls.filter((c) => c.method === "contacts_mirror_upsert_channel"),
    ).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// THE ATL-463 PIN — the crash window does not exist
// ---------------------------------------------------------------------------

describe("decide — ATL-463 crash-window closure", () => {
  test("a failed ACL outcome rolls the whole decision back: the request stays pending, no partial write, and a retry succeeds", async () => {
    // Induce the failure via the blocked-channel guard: the gateway refuses
    // to activate a blocked actor, which throws inside the transaction.
    seedGatewayChannel("blocked");
    const request = seedRequest();

    await expect(
      decideGuardianRequest(activateDecision(request.id)),
    ).rejects.toThrow("gateway refused the member activation");

    // The CAS rolled back with the outcome: the row never says "approved"
    // without its ACL write — there is no window, only one commit.
    const row = requestRow(request.id);
    expect(row?.status).toBe("pending");
    expect(row?.decidedByPrincipalId).toBeNull();
    expect(channelRows()[0]!.status).toBe("blocked");
    expect(mirrorCalls).toHaveLength(0);

    // The request is still decidable: once the inducement clears, the SAME
    // decide call succeeds end-to-end (no reopen machinery required).
    getGatewayDb()
      .update(contactChannels)
      .set({ status: "unverified" })
      .where(eq(contactChannels.id, "ch-seeded"))
      .run();

    const retry = await decideGuardianRequest(activateDecision(request.id));
    expect(retry.applied).toBe(true);
    expect(requestRow(request.id)?.status).toBe("approved");
    expect(channelRows()[0]!.status).toBe("active");
  });

  test("a thrown outcome write (guardian-downgrade guard on block) rolls the denial back", async () => {
    seedGatewayChannel("active", { role: "guardian" });
    const request = seedRequest();

    await expect(
      decideGuardianRequest({
        id: request.id,
        expectedStatus: "pending",
        status: "denied",
        aclOutcome: {
          type: "block",
          sourceChannel: CHANNEL,
          externalUserId: SENDER,
          reason: "introduction_block",
        },
      }),
    ).rejects.toThrow("Cannot downgrade a guardian channel");

    expect(requestRow(request.id)?.status).toBe("pending");
    expect(channelRows()[0]!.status).toBe("active");
  });

  test("a conflicted outbound-session mint rolls the approval back", async () => {
    // A guarded mint (ifNoneActive) against a channel that already has an
    // active session conflicts — the approval must not commit codeless.
    const existing = createOutboundSession({
      channel: CHANNEL,
      expectedExternalUserId: "someone-else",
      verificationPurpose: "trusted_contact",
    });
    const request = seedRequest();

    await expect(
      decideGuardianRequest({
        id: request.id,
        expectedStatus: "pending",
        status: "approved",
        aclOutcome: {
          type: "mint_outbound_session",
          channel: CHANNEL,
          expectedExternalUserId: SENDER,
          verificationPurpose: "trusted_contact",
          ifNoneActive: true,
        },
      }),
    ).rejects.toThrow("outbound session mint conflicted");

    expect(requestRow(request.id)?.status).toBe("pending");
    const sessions = sessionRows();
    expect(sessions).toHaveLength(1);
    expect(sessions[0]!.id).toBe(existing.sessionId);
  });
});

// ---------------------------------------------------------------------------
// Plain CAS (daemon-domain kinds) + mirror posture
// ---------------------------------------------------------------------------

describe("decide — without an outcome and mirror posture", () => {
  test("daemon-domain kinds decide as a plain CAS with no ACL writes", async () => {
    const request = seedRequest({ kind: "tool_approval", toolName: "bash" });

    const result = await decideGuardianRequest({
      id: request.id,
      expectedStatus: "pending",
      status: "approved",
      answerText: "yes",
      decidedByPrincipalId: "principal-1",
    });

    expect(result.applied).toBe(true);
    const row = requestRow(request.id);
    expect(row?.status).toBe("approved");
    expect(row?.answerText).toBe("yes");
    expect(channelRows()).toHaveLength(0);
    expect(sessionRows()).toHaveLength(0);
    expect(mirrorCalls).toHaveLength(0);
  });

  test("a post-commit mirror failure does not disturb the committed decision", async () => {
    mirrorThrow = true;
    const request = seedRequest();

    const result = await decideGuardianRequest(activateDecision(request.id));

    expect(result.applied).toBe(true);
    expect(requestRow(request.id)?.status).toBe("approved");
    expect(channelRows()[0]!.status).toBe("active");
  });

  test("a failed pre-transaction mirror lookup degrades to gateway-only activation", async () => {
    lookupImpl = async () => {
      throw new Error("identity lookup IPC failed");
    };
    const request = seedRequest();

    const result = await decideGuardianRequest(activateDecision(request.id));

    expect(result.applied).toBe(true);
    expect(requestRow(request.id)?.status).toBe("approved");
    expect(channelRows()[0]!.status).toBe("active");
  });
});
