/**
 * Tests for the gateway-backed verification-session client.
 *
 * The IPC transport is stubbed; each wrapper is exercised for method/param
 * mapping, contract-schema validation of responses, error propagation
 * (lifecycle wrappers throw fail-closed; validate-consume returns the
 * generic failure), and shape parity with the daemon session-service
 * results.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { VerificationSessionWire } from "@vellumai/gateway-client";

type IpcCall = { method: string; params?: Record<string, unknown> };

let ipcCalls: IpcCall[] = [];
let ipcResponse: unknown;
let ipcError: Error | null = null;

const ipcCallPersistentMock = mock(
  async (method: string, params?: Record<string, unknown>) => {
    ipcCalls.push({ method, params });
    if (ipcError) {
      throw ipcError;
    }
    return ipcResponse;
  },
);
const actualGatewayClient = await import("../../ipc/gateway-client.js");
mock.module("../../ipc/gateway-client.js", () => ({
  ...actualGatewayClient,
  ipcCallPersistent: ipcCallPersistentMock,
}));

const client = await import("../gateway-verification-sessions.js");
const { composeApprovalMessage } = await import(
  "../../runtime/approval-message-composer.js"
);

function makeWireSession(
  overrides: Partial<VerificationSessionWire> = {},
): VerificationSessionWire {
  return {
    id: "sess-1",
    channel: "telegram",
    challengeHash: "a".repeat(64),
    expiresAt: 1_700_000_600_000,
    status: "pending",
    sourceConversationId: null,
    consumedByExternalUserId: null,
    consumedByChatId: null,
    expectedExternalUserId: null,
    expectedChatId: null,
    expectedPhoneE164: null,
    identityBindingStatus: null,
    destinationAddress: null,
    lastSentAt: null,
    sendCount: 0,
    nextResendAt: null,
    codeDigits: 6,
    maxAttempts: 3,
    verificationPurpose: "guardian",
    bootstrapTokenHash: null,
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

const GENERIC_VERIFY_FAILED = composeApprovalMessage({
  scenario: "guardian_verify_failed",
  failureReason: "The verification code is invalid or has expired.",
});

beforeEach(() => {
  ipcCalls = [];
  ipcResponse = undefined;
  ipcError = null;
});

describe("createInboundVerificationSession", () => {
  test("returns the service result shape with a daemon-composed instruction", async () => {
    const session = makeWireSession();
    ipcResponse = {
      session,
      secret: "s3cret-hex",
      verifyCommand: "s3cret-hex",
      ttlSeconds: 600,
    };

    const result = await client.createInboundVerificationSession(
      "telegram",
      "conv-xyz",
    );

    expect(ipcCalls).toEqual([
      {
        method: "verification_sessions_create_inbound",
        params: { channel: "telegram", sourceConversationId: "conv-xyz" },
      },
    ]);
    expect(result).toEqual({
      challengeId: "sess-1",
      secret: "s3cret-hex",
      verifyCommand: "s3cret-hex",
      ttlSeconds: 600,
      instruction: composeApprovalMessage({
        scenario: "guardian_verify_challenge_setup",
        channel: "telegram",
        verifyCommand: "s3cret-hex",
      }),
    });
    expect(result.instruction).toContain("s3cret-hex");
  });

  test("throws on transport failure", async () => {
    ipcError = new Error("gateway unavailable");
    await expect(
      client.createInboundVerificationSession("telegram"),
    ).rejects.toThrow("gateway unavailable");
  });

  test("throws on a malformed response", async () => {
    ipcResponse = { secret: "s3cret-hex" };
    await expect(
      client.createInboundVerificationSession("telegram"),
    ).rejects.toThrow("verification_sessions_create_inbound");
  });
});

describe("createOutboundSession", () => {
  test("forwards params and returns the parsed create result", async () => {
    ipcResponse = {
      sessionId: "sess-2",
      secret: "123456",
      challengeHash: "b".repeat(64),
      expiresAt: 1_700_000_600_000,
      ttlSeconds: 600,
    };

    const result = await client.createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15555550123",
      destinationAddress: "+15555550123",
      codeDigits: 6,
      verificationPurpose: "guardian",
    });

    expect(ipcCalls[0]?.method).toBe("verification_sessions_create_outbound");
    expect(ipcCalls[0]?.params).toEqual({
      channel: "phone",
      expectedPhoneE164: "+15555550123",
      destinationAddress: "+15555550123",
      codeDigits: 6,
      verificationPurpose: "guardian",
    });
    expect(result).toEqual({
      sessionId: "sess-2",
      secret: "123456",
      challengeHash: "b".repeat(64),
      expiresAt: 1_700_000_600_000,
      ttlSeconds: 600,
    });
  });

  test("throws on a malformed response", async () => {
    ipcResponse = { sessionId: "sess-2" };
    await expect(
      client.createOutboundSession({ channel: "phone" }),
    ).rejects.toThrow("verification_sessions_create_outbound");
  });

  test("throws on transport failure", async () => {
    ipcError = new Error("gateway unavailable");
    await expect(
      client.createOutboundSession({ channel: "phone" }),
    ).rejects.toThrow("gateway unavailable");
  });
});

describe("session lookups", () => {
  test("getPendingSession returns the wire session", async () => {
    const session = makeWireSession();
    ipcResponse = session;

    const result = await client.getPendingSession("telegram");

    expect(ipcCalls).toEqual([
      {
        method: "verification_sessions_get_pending",
        params: { channel: "telegram" },
      },
    ]);
    expect(result).toEqual(session);
  });

  test("getPendingSession returns null when no session exists", async () => {
    ipcResponse = null;
    expect(await client.getPendingSession("telegram")).toBeNull();
  });

  test("findActiveSession round-trips and returns null on null", async () => {
    const session = makeWireSession({
      status: "awaiting_response",
      identityBindingStatus: "bound",
      expectedPhoneE164: "+15555550123",
    });
    ipcResponse = session;
    expect(await client.findActiveSession("phone")).toEqual(session);
    expect(ipcCalls[0]).toEqual({
      method: "verification_sessions_find_active",
      params: { channel: "phone" },
    });

    ipcResponse = null;
    expect(await client.findActiveSession("phone")).toBeNull();
  });

  test("lookups throw on a malformed session payload", async () => {
    ipcResponse = { id: "sess-1" };
    await expect(client.getPendingSession("telegram")).rejects.toThrow(
      "verification_sessions_get_pending",
    );
    await expect(client.findActiveSession("telegram")).rejects.toThrow(
      "verification_sessions_find_active",
    );
  });

  test("lookups throw on transport failure", async () => {
    ipcError = new Error("gateway unavailable");
    await expect(client.getPendingSession("telegram")).rejects.toThrow(
      "gateway unavailable",
    );
  });
});

describe("resolveBootstrapToken", () => {
  test("relays the RAW token — hashing is gateway-side", async () => {
    const session = makeWireSession({
      status: "pending_bootstrap",
      identityBindingStatus: "pending_bootstrap",
      bootstrapTokenHash: "c".repeat(64),
    });
    ipcResponse = session;

    const result = await client.resolveBootstrapToken(
      "telegram",
      "raw-deep-link-token",
    );

    expect(ipcCalls).toEqual([
      {
        method: "verification_sessions_resolve_bootstrap",
        params: { channel: "telegram", token: "raw-deep-link-token" },
      },
    ]);
    expect(result).toEqual(session);
  });

  test("returns null when no session matches", async () => {
    ipcResponse = null;
    expect(
      await client.resolveBootstrapToken("telegram", "raw-deep-link-token"),
    ).toBeNull();
  });
});

describe("session mutations", () => {
  test("bindSessionIdentity sends identity fields and resolves on ok", async () => {
    ipcResponse = { ok: true };
    await client.bindSessionIdentity("sess-1", "user-123", "chat-456");
    expect(ipcCalls).toEqual([
      {
        method: "verification_sessions_bind_identity",
        params: {
          sessionId: "sess-1",
          externalUserId: "user-123",
          chatId: "chat-456",
        },
      },
    ]);
  });

  test("updateSessionStatus maps extra consumed-by fields", async () => {
    ipcResponse = { ok: true };
    await client.updateSessionStatus("sess-1", "consumed", {
      consumedByExternalUserId: "user-123",
      consumedByChatId: "chat-456",
    });
    expect(ipcCalls[0]?.method).toBe("verification_sessions_update_status");
    expect(ipcCalls[0]?.params).toEqual({
      sessionId: "sess-1",
      status: "consumed",
      consumedByExternalUserId: "user-123",
      consumedByChatId: "chat-456",
    });
  });

  test("updateSessionStatus works without extra fields", async () => {
    ipcResponse = { ok: true };
    await client.updateSessionStatus("sess-1", "revoked");
    expect(ipcCalls[0]?.params).toEqual({
      sessionId: "sess-1",
      status: "revoked",
      consumedByExternalUserId: undefined,
      consumedByChatId: undefined,
    });
  });

  test("updateSessionDelivery sends delivery tracking fields", async () => {
    ipcResponse = { ok: true };
    await client.updateSessionDelivery("sess-1", 1_700_000_100_000, 2, null);
    expect(ipcCalls).toEqual([
      {
        method: "verification_sessions_update_delivery",
        params: {
          sessionId: "sess-1",
          lastSentAt: 1_700_000_100_000,
          sendCount: 2,
          nextResendAt: null,
        },
      },
    ]);
  });

  test("revokePendingSessions sends the channel", async () => {
    ipcResponse = { ok: true };
    await client.revokePendingSessions("phone");
    expect(ipcCalls).toEqual([
      {
        method: "verification_sessions_revoke_pending",
        params: { channel: "phone" },
      },
    ]);
  });

  test("mutations throw on transport failure", async () => {
    ipcError = new Error("gateway unavailable");
    await expect(
      client.bindSessionIdentity("sess-1", "user-123", "chat-456"),
    ).rejects.toThrow("gateway unavailable");
    await expect(client.revokePendingSessions("phone")).rejects.toThrow(
      "gateway unavailable",
    );
  });

  test("mutations throw when the gateway does not ack ok", async () => {
    ipcResponse = { ok: false };
    await expect(
      client.updateSessionStatus("sess-1", "revoked"),
    ).rejects.toThrow("verification_sessions_update_status");
  });

  test("mutations throw on a malformed ack", async () => {
    ipcResponse = { acknowledged: true };
    await expect(
      client.updateSessionDelivery("sess-1", 1, 1, null),
    ).rejects.toThrow("verification_sessions_update_delivery");
  });
});

describe("countRecentSendsToDestination", () => {
  test("returns the count from the gateway", async () => {
    ipcResponse = { count: 3 };
    const count = await client.countRecentSendsToDestination(
      "phone",
      "+15555550123",
      60_000,
    );
    expect(count).toBe(3);
    expect(ipcCalls).toEqual([
      {
        method: "verification_sessions_count_recent_sends",
        params: {
          channel: "phone",
          destinationAddress: "+15555550123",
          windowMs: 60_000,
        },
      },
    ]);
  });

  test("throws on a malformed response — the throttle must not fail open", async () => {
    ipcResponse = { total: 3 };
    await expect(
      client.countRecentSendsToDestination("phone", "+15555550123", 60_000),
    ).rejects.toThrow("verification_sessions_count_recent_sends");
  });

  test("throws on transport failure", async () => {
    ipcError = new Error("gateway unavailable");
    await expect(
      client.countRecentSendsToDestination("phone", "+15555550123", 60_000),
    ).rejects.toThrow("gateway unavailable");
  });
});

describe("validateAndConsumeVerification", () => {
  test("passes through a successful consume for each purpose", async () => {
    ipcResponse = { success: true, verificationType: "guardian" };
    expect(
      await client.validateAndConsumeVerification(
        "phone",
        "123456",
        "+15555550123",
        "+15555550123",
      ),
    ).toEqual({ success: true, verificationType: "guardian" });
    expect(ipcCalls[0]).toEqual({
      method: "verification_sessions_validate_consume",
      params: {
        channel: "phone",
        secret: "123456",
        actorExternalUserId: "+15555550123",
        actorChatId: "+15555550123",
      },
    });

    ipcResponse = { success: true, verificationType: "trusted_contact" };
    expect(
      await client.validateAndConsumeVerification(
        "telegram",
        "654321",
        "user-123",
        "chat-456",
      ),
    ).toEqual({ success: true, verificationType: "trusted_contact" });
  });

  test("composes the generic user-facing reason from a machine-readable failure", async () => {
    ipcResponse = { success: false, reason: "rate_limited" };
    const result = await client.validateAndConsumeVerification(
      "telegram",
      "000000",
      "user-123",
      "chat-456",
    );
    expect(result).toEqual({ success: false, reason: GENERIC_VERIFY_FAILED });
    // Anti-oracle: the machine reason never leaks into the user-facing copy.
    expect(GENERIC_VERIFY_FAILED).not.toContain("rate_limited");
  });

  test("fails closed without throwing on transport failure", async () => {
    ipcError = new Error("gateway unavailable");
    expect(
      await client.validateAndConsumeVerification(
        "phone",
        "123456",
        "+15555550123",
        "+15555550123",
      ),
    ).toEqual({ success: false, reason: GENERIC_VERIFY_FAILED });
  });

  test("fails closed on a malformed response", async () => {
    ipcResponse = { success: "yes" };
    expect(
      await client.validateAndConsumeVerification(
        "phone",
        "123456",
        "+15555550123",
        "+15555550123",
      ),
    ).toEqual({ success: false, reason: GENERIC_VERIFY_FAILED });
  });
});
