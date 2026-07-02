import { describe, test, expect, beforeEach, afterEach } from "bun:test";
import { eq } from "drizzle-orm";

import "../../__tests__/test-preload.js";
import { getGatewayDb, initGatewayDb, resetGatewayDb } from "../connection.js";
import { channelVerificationSessions } from "../schema.js";
import {
  bindSessionIdentity,
  consumeSession,
  countRecentSendsToDestination,
  createInboundSession,
  createOutboundSession,
  findActiveSession,
  findPendingSessionByHash,
  findPendingSessionForChannel,
  findSessionByBootstrapTokenHash,
  findSessionByIdentity,
  revokePendingSessions,
  updateSessionDelivery,
  updateSessionStatus,
} from "../session-store.js";
import type { SessionStatus, VerificationSession } from "../session-store.js";

// ---------------------------------------------------------------------------
// Setup / teardown
// ---------------------------------------------------------------------------

const FUTURE = () => Date.now() + 10 * 60 * 1000;
const PAST = () => Date.now() - 1000;

let idSeq = 0;
const nextId = () => `sess-${++idSeq}`;

beforeEach(async () => {
  resetGatewayDb();
  await initGatewayDb();
  getGatewayDb().delete(channelVerificationSessions).run();
});

afterEach(() => {
  resetGatewayDb();
});

function getRow(id: string) {
  return getGatewayDb()
    .select()
    .from(channelVerificationSessions)
    .where(eq(channelVerificationSessions.id, id))
    .get();
}

/** Insert a row directly, bypassing the store's revoke-prior-on-create. */
function insertRaw(
  overrides: Partial<typeof channelVerificationSessions.$inferInsert> & {
    id: string;
  },
) {
  const now = Date.now();
  getGatewayDb()
    .insert(channelVerificationSessions)
    .values({
      channel: "telegram",
      challengeHash: `hash-${overrides.id}`,
      expiresAt: FUTURE(),
      status: "pending",
      createdAt: now,
      updatedAt: now,
      ...overrides,
    })
    .run();
}

function createOutbound(
  overrides: Partial<Parameters<typeof createOutboundSession>[0]> = {},
): VerificationSession {
  const id = nextId();
  return createOutboundSession({
    id,
    channel: "telegram",
    challengeHash: `hash-${id}`,
    expiresAt: FUTURE(),
    status: "awaiting_response",
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// createInboundSession
// ---------------------------------------------------------------------------

describe("createInboundSession", () => {
  test("round-trips a pending session with configuration defaults", () => {
    const session = createInboundSession({
      id: "in-1",
      channel: "telegram",
      challengeHash: "hash-in-1",
      expiresAt: FUTURE(),
      sourceConversationId: "conv-1",
    });

    expect(session.status).toBe("pending");
    expect(session.sourceConversationId).toBe("conv-1");
    expect(session.codeDigits).toBe(6);
    expect(session.maxAttempts).toBe(3);
    expect(session.verificationPurpose).toBe("guardian");
    expect(session.sendCount).toBe(0);

    const found = findPendingSessionForChannel("telegram");
    expect(found?.id).toBe("in-1");
    expect(found).toEqual(session);
  });

  test("revokes prior pending sessions on the same channel", () => {
    const first = createInboundSession({
      id: "in-1",
      channel: "telegram",
      challengeHash: "hash-1",
      expiresAt: FUTURE(),
    });
    createInboundSession({
      id: "in-2",
      channel: "telegram",
      challengeHash: "hash-2",
      expiresAt: FUTURE(),
    });

    expect(getRow(first.id)?.status).toBe("revoked");
    expect(getRow("in-2")?.status).toBe("pending");
  });

  test("does not revoke pending sessions on other channels", () => {
    createInboundSession({
      id: "in-slack",
      channel: "slack",
      challengeHash: "hash-s",
      expiresAt: FUTURE(),
    });
    createInboundSession({
      id: "in-tg",
      channel: "telegram",
      challengeHash: "hash-t",
      expiresAt: FUTURE(),
    });

    expect(getRow("in-slack")?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// createOutboundSession
// ---------------------------------------------------------------------------

describe("createOutboundSession", () => {
  test("round-trips caller-supplied status and identity fields", () => {
    const session = createOutbound({
      status: "pending_bootstrap",
      expectedPhoneE164: "+15551234567",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "+15551234567",
      codeDigits: 8,
      maxAttempts: 5,
      verificationPurpose: "trusted_contact",
      bootstrapTokenHash: "boot-hash",
    });

    const row = getRow(session.id);
    expect(row?.status).toBe("pending_bootstrap");
    expect(row?.expectedPhoneE164).toBe("+15551234567");
    expect(row?.identityBindingStatus).toBe("pending_bootstrap");
    expect(row?.destinationAddress).toBe("+15551234567");
    expect(row?.codeDigits).toBe(8);
    expect(row?.maxAttempts).toBe(5);
    expect(row?.verificationPurpose).toBe("trusted_contact");
    expect(row?.bootstrapTokenHash).toBe("boot-hash");
  });

  test("revokes prior interceptable sessions on the same channel", () => {
    for (const status of [
      "pending",
      "pending_bootstrap",
      "awaiting_response",
    ] as SessionStatus[]) {
      insertRaw({ id: `prior-${status}`, status });
    }
    insertRaw({ id: "prior-consumed", status: "consumed" });

    const session = createOutbound();

    expect(getRow("prior-pending")?.status).toBe("revoked");
    expect(getRow("prior-pending_bootstrap")?.status).toBe("revoked");
    expect(getRow("prior-awaiting_response")?.status).toBe("revoked");
    expect(getRow("prior-consumed")?.status).toBe("consumed");
    expect(getRow(session.id)?.status).toBe("awaiting_response");
  });
});

// ---------------------------------------------------------------------------
// revokePendingSessions
// ---------------------------------------------------------------------------

describe("revokePendingSessions", () => {
  test("revokes only pending sessions on the channel", () => {
    insertRaw({ id: "p1", status: "pending" });
    insertRaw({ id: "a1", status: "awaiting_response" });
    insertRaw({ id: "other", channel: "slack", status: "pending" });

    revokePendingSessions("telegram");

    expect(getRow("p1")?.status).toBe("revoked");
    expect(getRow("a1")?.status).toBe("awaiting_response");
    expect(getRow("other")?.status).toBe("pending");
  });
});

// ---------------------------------------------------------------------------
// findPendingSessionByHash
// ---------------------------------------------------------------------------

describe("findPendingSessionByHash", () => {
  test("matches every interceptable status", () => {
    for (const status of [
      "pending",
      "pending_bootstrap",
      "awaiting_response",
    ] as SessionStatus[]) {
      insertRaw({ id: `s-${status}`, status, challengeHash: `h-${status}` });
      expect(findPendingSessionByHash("telegram", `h-${status}`)?.id).toBe(
        `s-${status}`,
      );
    }
  });

  test("ignores non-interceptable statuses", () => {
    for (const status of [
      "consumed",
      "revoked",
      "expired",
      "verified",
      "locked",
    ] as SessionStatus[]) {
      insertRaw({ id: `s-${status}`, status, challengeHash: `h-${status}` });
      expect(findPendingSessionByHash("telegram", `h-${status}`)).toBeNull();
    }
  });

  test("ignores expired sessions", () => {
    insertRaw({ id: "stale", challengeHash: "h-stale", expiresAt: PAST() });
    expect(findPendingSessionByHash("telegram", "h-stale")).toBeNull();
  });

  test("ignores other channels", () => {
    insertRaw({ id: "s1", channel: "slack", challengeHash: "h1" });
    expect(findPendingSessionByHash("telegram", "h1")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findPendingSessionForChannel
// ---------------------------------------------------------------------------

describe("findPendingSessionForChannel", () => {
  test("matches 'pending' only — outbound statuses are excluded", () => {
    insertRaw({ id: "boot", status: "pending_bootstrap" });
    insertRaw({ id: "await", status: "awaiting_response" });
    expect(findPendingSessionForChannel("telegram")).toBeNull();

    insertRaw({ id: "pend", status: "pending" });
    expect(findPendingSessionForChannel("telegram")?.id).toBe("pend");
  });

  test("ignores expired sessions", () => {
    insertRaw({ id: "stale", status: "pending", expiresAt: PAST() });
    expect(findPendingSessionForChannel("telegram")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findActiveSession
// ---------------------------------------------------------------------------

describe("findActiveSession", () => {
  test("matches pending_bootstrap and awaiting_response, not pending", () => {
    insertRaw({ id: "pend", status: "pending" });
    expect(findActiveSession("telegram")).toBeNull();

    insertRaw({ id: "boot", status: "pending_bootstrap" });
    expect(findActiveSession("telegram")?.id).toBe("boot");
  });

  test("returns the newest session first", () => {
    const now = Date.now();
    insertRaw({ id: "old", status: "awaiting_response", createdAt: now - 500 });
    insertRaw({ id: "new", status: "awaiting_response", createdAt: now });
    expect(findActiveSession("telegram")?.id).toBe("new");
  });

  test("ignores expired sessions", () => {
    insertRaw({ id: "stale", status: "awaiting_response", expiresAt: PAST() });
    expect(findActiveSession("telegram")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findSessionByBootstrapTokenHash
// ---------------------------------------------------------------------------

describe("findSessionByBootstrapTokenHash", () => {
  test("matches a non-expired pending_bootstrap session by token hash", () => {
    insertRaw({
      id: "boot",
      status: "pending_bootstrap",
      bootstrapTokenHash: "tok-1",
    });
    expect(findSessionByBootstrapTokenHash("telegram", "tok-1")?.id).toBe(
      "boot",
    );
    expect(findSessionByBootstrapTokenHash("telegram", "tok-2")).toBeNull();
  });

  test("ignores bound and expired sessions", () => {
    insertRaw({
      id: "bound",
      status: "awaiting_response",
      bootstrapTokenHash: "tok-bound",
    });
    insertRaw({
      id: "stale",
      status: "pending_bootstrap",
      bootstrapTokenHash: "tok-stale",
      expiresAt: PAST(),
    });
    expect(findSessionByBootstrapTokenHash("telegram", "tok-bound")).toBeNull();
    expect(findSessionByBootstrapTokenHash("telegram", "tok-stale")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// findSessionByIdentity
// ---------------------------------------------------------------------------

describe("findSessionByIdentity", () => {
  test("returns null when no identity parameter is supplied", () => {
    insertRaw({ id: "s1", status: "awaiting_response" });
    expect(findSessionByIdentity("telegram")).toBeNull();
  });

  test("matches on any supplied identity field", () => {
    insertRaw({
      id: "s1",
      status: "awaiting_response",
      expectedExternalUserId: "user-1",
      expectedChatId: "chat-1",
      expectedPhoneE164: "+15550001111",
    });

    expect(findSessionByIdentity("telegram", "user-1")?.id).toBe("s1");
    expect(findSessionByIdentity("telegram", undefined, "chat-1")?.id).toBe(
      "s1",
    );
    expect(
      findSessionByIdentity("telegram", undefined, undefined, "+15550001111")
        ?.id,
    ).toBe("s1");
    expect(findSessionByIdentity("telegram", "user-other")).toBeNull();
  });

  test("ignores expired and non-active sessions", () => {
    insertRaw({
      id: "stale",
      status: "awaiting_response",
      expectedExternalUserId: "user-1",
      expiresAt: PAST(),
    });
    insertRaw({
      id: "done",
      status: "consumed",
      expectedExternalUserId: "user-2",
    });
    expect(findSessionByIdentity("telegram", "user-1")).toBeNull();
    expect(findSessionByIdentity("telegram", "user-2")).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// consumeSession
// ---------------------------------------------------------------------------

describe("consumeSession", () => {
  test("consumes an interceptable session and stamps the actor", () => {
    insertRaw({ id: "s1", status: "awaiting_response" });

    expect(consumeSession("s1", "user-1", "chat-1")).toBe(true);

    const row = getRow("s1");
    expect(row?.status).toBe("consumed");
    expect(row?.consumedByExternalUserId).toBe("user-1");
    expect(row?.consumedByChatId).toBe("chat-1");
  });

  test("exactly one of two racing consumers wins", () => {
    insertRaw({ id: "s1", status: "pending" });

    const first = consumeSession("s1", "user-1", "chat-1");
    const second = consumeSession("s1", "user-2", "chat-2");

    expect(first).toBe(true);
    expect(second).toBe(false);

    // The loser must not overwrite the winner's actor stamp.
    const row = getRow("s1");
    expect(row?.consumedByExternalUserId).toBe("user-1");
    expect(row?.consumedByChatId).toBe("chat-1");
  });

  test("returns false for consumed/revoked/expired/verified/locked rows", () => {
    for (const status of [
      "consumed",
      "revoked",
      "expired",
      "verified",
      "locked",
    ] as SessionStatus[]) {
      insertRaw({ id: `s-${status}`, status });
      expect(consumeSession(`s-${status}`, "user-1", "chat-1")).toBe(false);
      expect(getRow(`s-${status}`)?.status).toBe(status);
    }
  });

  test("returns false for a nonexistent session", () => {
    expect(consumeSession("missing", "user-1", "chat-1")).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// updateSessionStatus / updateSessionDelivery / bindSessionIdentity
// ---------------------------------------------------------------------------

describe("updateSessionStatus", () => {
  test("transitions status and applies extra fields when supplied", () => {
    insertRaw({ id: "s1", status: "awaiting_response" });

    updateSessionStatus("s1", "verified", {
      consumedByExternalUserId: "user-1",
      consumedByChatId: "chat-1",
    });

    const row = getRow("s1");
    expect(row?.status).toBe("verified");
    expect(row?.consumedByExternalUserId).toBe("user-1");
    expect(row?.consumedByChatId).toBe("chat-1");

    updateSessionStatus("s1", "revoked");
    const after = getRow("s1");
    expect(after?.status).toBe("revoked");
    expect(after?.consumedByExternalUserId).toBe("user-1");
  });
});

describe("updateSessionDelivery", () => {
  test("round-trips delivery tracking fields", () => {
    insertRaw({ id: "s1", status: "awaiting_response" });
    const sentAt = Date.now();

    updateSessionDelivery("s1", sentAt, 2, sentAt + 60_000);

    const row = getRow("s1");
    expect(row?.lastSentAt).toBe(sentAt);
    expect(row?.sendCount).toBe(2);
    expect(row?.nextResendAt).toBe(sentAt + 60_000);
  });
});

describe("bindSessionIdentity", () => {
  test("binds identity fields and flips binding status to bound", () => {
    insertRaw({
      id: "s1",
      status: "pending_bootstrap",
      identityBindingStatus: "pending_bootstrap",
    });

    bindSessionIdentity("s1", "user-1", "chat-1");

    const row = getRow("s1");
    expect(row?.expectedExternalUserId).toBe("user-1");
    expect(row?.expectedChatId).toBe("chat-1");
    expect(row?.identityBindingStatus).toBe("bound");
  });
});

// ---------------------------------------------------------------------------
// countRecentSendsToDestination
// ---------------------------------------------------------------------------

describe("countRecentSendsToDestination", () => {
  test("counts rows sent to the destination within the window", () => {
    const now = Date.now();
    const dest = "+15550001111";

    insertRaw({
      id: "recent-1",
      destinationAddress: dest,
      lastSentAt: now - 1000,
    });
    insertRaw({
      id: "recent-2",
      destinationAddress: dest,
      lastSentAt: now - 2000,
    });
    insertRaw({
      id: "old",
      destinationAddress: dest,
      lastSentAt: now - 60 * 60 * 1000,
    });
    insertRaw({
      id: "other-dest",
      destinationAddress: "+15559998888",
      lastSentAt: now - 1000,
    });
    insertRaw({ id: "never-sent", destinationAddress: dest });

    expect(
      countRecentSendsToDestination("telegram", dest, 15 * 60 * 1000),
    ).toBe(2);
    expect(countRecentSendsToDestination("slack", dest, 15 * 60 * 1000)).toBe(
      0,
    );
  });
});
