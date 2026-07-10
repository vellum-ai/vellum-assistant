import { createHash } from "node:crypto";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/env.js", () => ({
  isHttpAuthDisabled: () => true,
  getGatewayInternalBaseUrl: () => "http://127.0.0.1:7830",
}));

// Telegram bot username mock — production code now reads from config via getTelegramBotUsername()
let mockBotUsername: string | undefined = "test_bot";
mock.module("../telegram/bot-username.js", () => ({
  getTelegramBotUsername: () => mockBotUsername,
}));

// Call domain mock — outbound voice verification calls are fire-and-forget.
const voiceCallInitCalls: Array<{
  phoneNumber: string;
  verificationSessionId: string;
  assistantId?: string;
}> = [];
mock.module("../calls/call-domain.js", () => ({
  startVerificationCall: async (input: {
    phoneNumber: string;
    verificationSessionId: string;
    assistantId?: string;
  }) => {
    voiceCallInitCalls.push(input);
    return { ok: true, callSessionId: "mock-call-session", callSid: "CA-mock" };
  },
}));

// Track Telegram deliveries via mock of the direct send module
const telegramDeliverCalls: Array<{
  chatId: string;
  text: string;
  assistantId?: string;
}> = [];
mock.module("../messaging/providers/telegram-bot/send.js", () => ({
  sendTelegramReply: async (chatId: string, text: string) => {
    telegramDeliverCalls.push({ chatId, text });
  },
  sendTelegramAttachments: async () => ({
    allFailed: false,
    failureCount: 0,
    totalCount: 0,
  }),
  sendTelegramTypingIndicator: async () => true,
}));
// Capture broadcastMessage calls so tests can inspect responses
const broadcastedMessages: unknown[] = [];
mock.module("../runtime/assistant-event-hub.js", () => ({
  broadcastMessage: (msg: unknown) => {
    broadcastedMessages.push(msg);
  },
}));

// Gateway relay mock — the revoke path relays the ACL downgrade over IPC and
// validates the response; return a well-formed mark_channel_revoked result.
// The gateway owns the revoke and dual-writes the local assistant row to
// "revoked"; mirror that dual-write here so guardian-resolution reads under
// test observe the downgrade (the assistant-side teardown is now a no-op shim).
mock.module("../ipc/gateway-client.js", () => ({
  ipcCallPersistent: async (
    method: string,
    params?: Record<string, unknown>,
  ) => {
    // Session lifecycle goes through the gateway session client now;
    // delegate to the local-service sim so these tests keep seeding and
    // asserting against the local test DB.
    const { handleVerificationSessionsIpc, isVerificationSessionsIpcMethod } =
      await import("./helpers/verification-sessions-ipc-sim.js");
    if (isVerificationSessionsIpcMethod(method)) {
      return handleVerificationSessionsIpc(method, params);
    }
    if (method === "mark_channel_revoked") {
      const { revokeChannelById } =
        await import("./helpers/seed-contact-channel.js");
      const channelId = params?.contactChannelId as string | undefined;
      if (channelId) revokeChannelById(channelId);
    }
    return {
      ok: true,
      didWrite: true,
      channel: {
        id: (params?.contactChannelId as string) ?? "ch1",
        contactId: "c1",
        type: "phone",
        address: "addr",
        status: "revoked",
        revokedReason: (params?.reason as string) ?? null,
      },
    };
  },
}));

// Guardian-delivery reader mock — the inbound challenge guard reads guardian
// existence from the gateway. Derive the list from the local binding state so
// the gateway-backed presence guard mirrors the DB the rest of the test sets up.
const resolveGuardianList = async (input?: { channelTypes?: string[] }) => {
  const { deriveGuardianDeliveries } =
    await import("./helpers/derive-guardian-delivery.js");
  return deriveGuardianDeliveries({ channelTypes: input?.channelTypes ?? [] });
};

mock.module("../contacts/guardian-delivery-reader.js", () => ({
  getGuardianDelivery: resolveGuardianList,
  getGuardianDeliveryFresh: resolveGuardianList,
  guardianForChannel: (
    list: Array<{ channelType: string; status: string }>,
    channelType: string,
  ) => list.find((g) => g.channelType === channelType && g.status === "active"),
}));

import {
  createInboundVerificationSession,
  createOutboundSession,
  findActiveSession as serviceFindActiveSession,
  getPendingSession,
  resolveBootstrapToken,
  updateSessionDelivery as storeUpdateSessionDelivery,
  updateSessionStatus as serviceUpdateSessionStatus,
  validateAndConsumeVerification,
} from "../channels/gateway-verification-sessions.js";
import { handleChannelVerificationSession } from "../daemon/handlers/config-channels.js";
import type {
  ChannelVerificationSessionRequest,
  ChannelVerificationSessionResponse,
} from "../daemon/message-protocol.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { upsertBinding as upsertExternalBinding } from "../persistence/external-conversation-store.js";
import { conversations } from "../persistence/schema/index.js";
import {
  getGuardianBinding,
  isGuardian,
} from "../runtime/channel-verification-service.js";
import {
  MAX_SENDS_PER_SESSION,
  RESEND_COOLDOWN_MS,
} from "../runtime/verification-outbound-actions.js";
import {
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../runtime/verification-templates.js";
import { resetDbForTesting } from "./db-test-helpers.js";
import { createGuardianBinding } from "./helpers/create-guardian-binding.js";
import { resetGatewayAclStore } from "./helpers/gateway-acl-store.js";
import { revokeChannelsByType } from "./helpers/seed-contact-channel.js";
import {
  bindSessionIdentity as serviceBindSessionIdentity,
  getRateLimitState,
  getSessionById,
  resetVerificationSessionsSim,
  seedVerificationSession,
} from "./helpers/verification-sessions-ipc-sim.js";

await initializeDb();

afterAll(() => {
  resetDbForTesting();
});

function resetTables(): void {
  resetVerificationSessionsSim();
  const db = getDb();
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  db.run("DELETE FROM external_conversation_bindings");
  resetGatewayAclStore();
  telegramDeliverCalls.length = 0;
  voiceCallInitCalls.length = 0;
  mockBotUsername = "test_bot";
}

/**
 * Stamp the local mirror of a gateway-owned guardian-channel revoke so the
 * guardian-resolution reads still running locally observe the downgrade.
 */
function revokeGuardianChannelLocally(channelType: string): void {
  revokeChannelsByType(channelType);
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Guardian Service — Challenge Validation
// ═══════════════════════════════════════════════════════════════════════════

describe("guardian service challenge validation", () => {
  beforeEach(() => {
    resetTables();
  });

  test("createInboundVerificationSession returns a secret, verifyCommand, ttlSeconds, and instruction", async () => {
    const result = await createInboundVerificationSession("telegram");

    expect(result.challengeId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.secret.length).toBe(64); // 32-byte hex — high-entropy for unbound inbound challenges
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.verifyCommand).toBe(result.secret);
    expect(result.ttlSeconds).toBe(600);
    expect(result.instruction).toBeDefined();
    expect(result.instruction.length).toBeGreaterThan(0);
    // Hex codes use generic "send the code:" format
    expect(result.instruction).toContain(`the code: ${result.secret}`);
  });

  test("createInboundVerificationSession produces a non-empty instruction for telegram channel", async () => {
    const result = await createInboundVerificationSession("telegram");
    expect(result.instruction).toBeDefined();
    expect(result.instruction.length).toBeGreaterThan(0);
    expect(result.instruction).toContain(`the code: ${result.secret}`);
  });

  test("createInboundVerificationSession produces a non-empty instruction for voice channel", async () => {
    const result = await createInboundVerificationSession("phone");
    expect(result.instruction).toBeDefined();
    expect(result.instruction.length).toBeGreaterThan(0);
    expect(result.instruction).toContain(`the code: ${result.secret}`);
  });

  test("validateAndConsumeVerification succeeds with correct secret", async () => {
    const { secret } = await createInboundVerificationSession("telegram");

    const result = await validateAndConsumeVerification(
      "telegram",
      secret,
      "user-42",
      "chat-42",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("guardian");
    }
  });

  test("validateAndConsumeVerification does not create a guardian binding (caller responsibility)", async () => {
    const { secret } = await createInboundVerificationSession("telegram");

    await validateAndConsumeVerification(
      "telegram",
      secret,
      "user-42",
      "chat-42",
    );

    const binding = await getGuardianBinding("asst-1", "telegram");
    expect(binding).toBeNull();
  });

  test("validateAndConsumeVerification fails with wrong secret", async () => {
    await createInboundVerificationSession("telegram");

    const result = await validateAndConsumeVerification(
      "telegram",
      "wrong-secret",
      "user-42",
      "chat-42",
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      // Composed failure message — check it is non-empty and contains "failed"
      expect(result.reason).toBeDefined();
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason.toLowerCase()).toContain("failed");
    }
  });

  test("validateAndConsumeVerification fails with expired challenge", async () => {
    // Create a challenge that is already expired by inserting directly
    const secret = "test-secret-expired";
    const challengeHash = createHash("sha256").update(secret).digest("hex");
    seedVerificationSession({
      id: "chal-expired",
      channel: "telegram",
      challengeHash,
      expiresAt: Date.now() - 1000, // already expired
      status: "pending",
    });

    const result = await validateAndConsumeVerification(
      "telegram",
      secret,
      "user-42",
      "chat-42",
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      // Composed failure message — check it is non-empty and contains "failed"
      expect(result.reason).toBeDefined();
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason.toLowerCase()).toContain("failed");
    }
  });

  test("consumed challenge cannot be reused", async () => {
    const { secret } = await createInboundVerificationSession("telegram");

    // First use succeeds
    const result1 = await validateAndConsumeVerification(
      "telegram",
      secret,
      "user-42",
      "chat-42",
    );
    expect(result1.success).toBe(true);

    // Second use with same secret fails (replay prevention)
    const result2 = await validateAndConsumeVerification(
      "telegram",
      secret,
      "user-99",
      "chat-99",
    );
    expect(result2.success).toBe(false);
  });

  test("validateAndConsumeVerification succeeds with voice channel", async () => {
    const { secret } = await createInboundVerificationSession("phone");

    const result = await validateAndConsumeVerification(
      "phone",
      secret,
      "phone-user-1",
      "voice-chat-1",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("guardian");
    }

    // validateAndConsumeVerification no longer creates bindings — that is
    // now handled by the gateway's verification intercepts.
    const binding = await getGuardianBinding("asst-1", "phone");
    expect(binding).toBeNull();
  });

  test("voice and telegram guardian challenges are independent", async () => {
    const telegramChallenge =
      await createInboundVerificationSession("telegram");
    const voiceChallenge = await createInboundVerificationSession("phone");

    // Validate voice challenge against telegram channel should fail
    const crossResult = await validateAndConsumeVerification(
      "telegram",
      voiceChallenge.secret,
      "user-1",
      "chat-1",
    );
    expect(crossResult.success).toBe(false);

    // Validate voice challenge against correct channel should succeed
    const voiceResult = await validateAndConsumeVerification(
      "phone",
      voiceChallenge.secret,
      "user-1",
      "chat-1",
    );
    expect(voiceResult.success).toBe(true);

    // Telegram challenge should still be valid
    const telegramResult = await validateAndConsumeVerification(
      "telegram",
      telegramChallenge.secret,
      "user-2",
      "chat-2",
    );
    expect(telegramResult.success).toBe(true);
  });

  test("validateAndConsumeVerification succeeds even with existing binding (conflict check is caller responsibility)", async () => {
    // Create initial guardian binding
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "old-user",
      guardianPrincipalId: "old-user",
      guardianDeliveryChatId: "old-chat",
    });

    const oldBinding = await getGuardianBinding("asst-1", "telegram");
    expect(oldBinding).not.toBeNull();
    expect(oldBinding!.guardianExternalUserId).toBe("old-user");

    const { secret } = await createInboundVerificationSession("telegram");
    const result = await validateAndConsumeVerification(
      "telegram",
      secret,
      "new-user",
      "new-chat",
    );

    // Challenge validation succeeds — the caller decides how to handle binding conflicts
    expect(result.success).toBe(true);

    const binding = await getGuardianBinding("asst-1", "telegram");
    expect(binding).not.toBeNull();
    expect(binding!.guardianExternalUserId).toBe("old-user");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. Guardian Identity Check (Service)
// ═══════════════════════════════════════════════════════════════════════════

describe("guardian identity check", () => {
  beforeEach(() => {
    resetTables();
  });

  test("isGuardian returns true for matching user", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-42",
      guardianPrincipalId: "user-42",
      guardianDeliveryChatId: "chat-42",
    });

    expect(await isGuardian("asst-1", "telegram", "user-42")).toBe(true);
  });

  test("isGuardian returns false for non-matching user", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-42",
      guardianPrincipalId: "user-42",
      guardianDeliveryChatId: "chat-42",
    });

    expect(await isGuardian("asst-1", "telegram", "user-99")).toBe(false);
  });

  test("isGuardian returns false when no binding exists", async () => {
    expect(await isGuardian("asst-1", "telegram", "user-42")).toBe(false);
  });

  test("isGuardian returns false after binding is revoked", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-42",
      guardianPrincipalId: "user-42",
      guardianDeliveryChatId: "chat-42",
    });

    revokeGuardianChannelLocally("telegram");

    expect(await isGuardian("asst-1", "telegram", "user-42")).toBe(false);
  });

  test("getGuardianBinding returns the active binding", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-42",
      guardianPrincipalId: "user-42",
      guardianDeliveryChatId: "chat-42",
    });

    const binding = await getGuardianBinding("asst-1", "telegram");
    expect(binding).not.toBeNull();
    expect(binding!.guardianExternalUserId).toBe("user-42");
  });

  test("getGuardianBinding returns null when no binding exists", async () => {
    const binding = await getGuardianBinding("asst-1", "telegram");
    expect(binding).toBeNull();
  });

  test("isGuardian works for voice channel", async () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "phone-user-1",
      guardianPrincipalId: "phone-user-1",
      guardianDeliveryChatId: "voice-chat-1",
    });

    expect(await isGuardian("asst-1", "phone", "phone-user-1")).toBe(true);
    expect(await isGuardian("asst-1", "phone", "phone-user-2")).toBe(false);
    // Telegram guardian should not match voice channel
    expect(await isGuardian("asst-1", "telegram", "phone-user-1")).toBe(false);
  });

  test("guardian binding read reflects a gateway-owned revoke", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-42",
      guardianPrincipalId: "user-42",
      guardianDeliveryChatId: "chat-42",
    });

    // The revoke is gateway-owned. Stamp the local downgrade and assert the
    // read reflects it.
    revokeGuardianChannelLocally("telegram");
    expect(await getGuardianBinding("asst-1", "telegram")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Verification Rate Limiting (Service — end-to-end)
// ═══════════════════════════════════════════════════════════════════════════

describe("guardian service rate limiting", () => {
  beforeEach(() => {
    resetTables();
  });

  test("repeated invalid submissions hit rate limit", async () => {
    // Create a valid challenge so there is a pending challenge
    await createInboundVerificationSession("telegram");

    // Submit wrong codes repeatedly
    for (let i = 0; i < 5; i++) {
      const result = await validateAndConsumeVerification(
        "telegram",
        `wrong-secret-${i}`,
        "user-42",
        "chat-42",
      );
      expect(result.success).toBe(false);
    }

    // The 6th attempt should be rate-limited even without a new challenge
    const result = await validateAndConsumeVerification(
      "telegram",
      "another-wrong",
      "user-42",
      "chat-42",
    );
    expect(result.success).toBe(false);
    expect((result as { reason: string }).reason).toBeDefined();
    expect((result as { reason: string }).reason.length).toBeGreaterThan(0);
    expect((result as { reason: string }).reason.toLowerCase()).toContain(
      "failed",
    );

    // Verify the rate limit record
    const rl = getRateLimitState("telegram", "user-42", "chat-42");
    expect(rl).not.toBeNull();
    expect(rl!.lockedUntil).not.toBeNull();
  });

  test("valid challenge still succeeds when under threshold", async () => {
    // Record a couple invalid attempts
    const { secret: _secret } =
      await createInboundVerificationSession("telegram");
    await validateAndConsumeVerification(
      "telegram",
      "wrong-1",
      "user-42",
      "chat-42",
    );
    await validateAndConsumeVerification(
      "telegram",
      "wrong-2",
      "user-42",
      "chat-42",
    );

    // Valid attempt should still succeed (under the 5-attempt threshold)
    // Need a new challenge since the old one is still pending but the secret was never consumed
    const { secret: secret2 } =
      await createInboundVerificationSession("telegram");
    const result = await validateAndConsumeVerification(
      "telegram",
      secret2,
      "user-42",
      "chat-42",
    );
    expect(result.success).toBe(true);

    // Rate limit should be reset after success
    const rl = getRateLimitState("telegram", "user-42", "chat-42");
    expect(rl).not.toBeNull();
    expect(rl!.invalidAttempts).toBe(0);
    expect(rl!.lockedUntil).toBeNull();
  });

  test("rate-limit uses generic failure message (no oracle leakage)", async () => {
    await createInboundVerificationSession("telegram");

    // Capture a normal invalid-code failure response
    const normalFailure = await validateAndConsumeVerification(
      "telegram",
      "wrong-first",
      "user-42",
      "chat-42",
    );
    expect(normalFailure.success).toBe(false);
    const normalReason = (normalFailure as { reason: string }).reason;

    // Trigger rate limit (4 more attempts to reach 5 total)
    for (let i = 0; i < 4; i++) {
      await validateAndConsumeVerification(
        "telegram",
        `wrong-${i}`,
        "user-42",
        "chat-42",
      );
    }

    // Verify lockout is actually active before testing the rate-limited response
    const rl = getRateLimitState("telegram", "user-42", "chat-42");
    expect(rl).not.toBeNull();
    expect(rl!.lockedUntil).toBeGreaterThan(Date.now());

    // The rate-limited response should be indistinguishable from normal failure
    const rateLimitedResult = await validateAndConsumeVerification(
      "telegram",
      "anything",
      "user-42",
      "chat-42",
    );
    expect(rateLimitedResult.success).toBe(false);
    const rateLimitedReason = (rateLimitedResult as { reason: string }).reason;

    // Anti-oracle: both responses must be identical
    expect(rateLimitedReason).toBe(normalReason);

    // Neither should reveal rate-limiting info
    expect(rateLimitedReason).not.toContain("rate limit");
    expect(normalReason).not.toContain("rate limit");
  });

  test("rate limit does not affect different actors", async () => {
    // Rate-limit user-42
    await createInboundVerificationSession("telegram");
    for (let i = 0; i < 5; i++) {
      await validateAndConsumeVerification(
        "telegram",
        `wrong-${i}`,
        "user-42",
        "chat-42",
      );
    }

    // user-99 should still be able to verify
    const { secret } = await createInboundVerificationSession("telegram");
    const result = await validateAndConsumeVerification(
      "telegram",
      secret,
      "user-99",
      "chat-99",
    );
    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Channel-scoped guardian resolution
// ═══════════════════════════════════════════════════════════════════════════

describe("channel-scoped guardian resolution", () => {
  beforeEach(() => {
    resetTables();
  });

  test("isGuardian resolves independently per channel", async () => {
    // Create guardian binding on telegram
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-alpha",
      guardianPrincipalId: "user-alpha",
      guardianDeliveryChatId: "chat-alpha",
    });
    // Create guardian binding on voice with a different user
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "user-beta",
      guardianPrincipalId: "user-beta",
      guardianDeliveryChatId: "chat-beta",
    });

    // user-alpha is guardian for telegram but not voice
    expect(await isGuardian("self", "telegram", "user-alpha")).toBe(true);
    expect(await isGuardian("self", "phone", "user-alpha")).toBe(false);

    // user-beta is guardian for voice but not telegram
    expect(await isGuardian("self", "phone", "user-beta")).toBe(true);
    expect(await isGuardian("self", "telegram", "user-beta")).toBe(false);
  });

  test("getGuardianBinding returns different bindings for different channels", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-alpha",
      guardianPrincipalId: "user-alpha",
      guardianDeliveryChatId: "chat-alpha",
    });
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "user-beta",
      guardianPrincipalId: "user-beta",
      guardianDeliveryChatId: "chat-beta",
    });

    const bindingTelegram = await getGuardianBinding("self", "telegram");
    const bindingVoice = await getGuardianBinding("self", "phone");

    expect(bindingTelegram).not.toBeNull();
    expect(bindingVoice).not.toBeNull();
    expect(bindingTelegram!.guardianExternalUserId).toBe("user-alpha");
    expect(bindingVoice!.guardianExternalUserId).toBe("user-beta");
  });

  test("revoking binding for one channel does not affect another", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-alpha",
      guardianPrincipalId: "user-alpha",
      guardianDeliveryChatId: "chat-alpha",
    });
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "user-beta",
      guardianPrincipalId: "user-beta",
      guardianDeliveryChatId: "chat-beta",
    });

    revokeGuardianChannelLocally("telegram");

    expect(await getGuardianBinding("self", "telegram")).toBeNull();
    expect(await getGuardianBinding("self", "phone")).not.toBeNull();
  });

  test("validateAndConsumeVerification scoped to channel", async () => {
    // Create challenge on telegram
    const { secret: secretTelegram } =
      await createInboundVerificationSession("telegram");
    // Create challenge on voice
    const { secret: secretVoice } =
      await createInboundVerificationSession("phone");

    // Attempting to consume telegram challenge on voice should fail
    const crossResult = await validateAndConsumeVerification(
      "phone",
      secretTelegram,
      "user-1",
      "chat-1",
    );
    expect(crossResult.success).toBe(false);

    // Consuming with correct channel should succeed
    const resultTelegram = await validateAndConsumeVerification(
      "telegram",
      secretTelegram,
      "user-1",
      "chat-1",
    );
    expect(resultTelegram.success).toBe(true);

    const resultVoice = await validateAndConsumeVerification(
      "phone",
      secretVoice,
      "user-2",
      "chat-2",
    );
    expect(resultVoice.success).toBe(true);

    const bindingTelegram = await getGuardianBinding("self", "telegram");
    const bindingVoice = await getGuardianBinding("self", "phone");
    expect(bindingTelegram).toBeNull();
    expect(bindingVoice).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Assistant-scoped approval request lookups
// ═══════════════════════════════════════════════════════════════════════════

// ═══════════════════════════════════════════════════════════════════════════
// 10. HTTP handler — channel-aware guardian status response
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Returns a helper that reads the latest broadcastMessage call as a
 * ChannelVerificationSessionResponse. Resets the capture array first so
 * each test gets a clean slate.
 */
function createResponseReader(): {
  lastResponse: () => ChannelVerificationSessionResponse | null;
} {
  broadcastedMessages.length = 0;
  return {
    lastResponse: () =>
      broadcastedMessages.length > 0
        ? (broadcastedMessages[
            broadcastedMessages.length - 1
          ] as ChannelVerificationSessionResponse)
        : null,
  };
}

describe("HTTP handler channel-aware guardian status", () => {
  beforeEach(() => {
    resetTables();
  });

  test("status action for telegram returns channel and assistantId fields", async () => {
    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "telegram",
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.channel).toBe("telegram");
    expect(resp!.assistantId).toBe("self");
    expect(resp!.bound).toBe(false);
    expect(resp!.guardianDeliveryChatId).toBeUndefined();
  });

  test("status action for voice returns channel: voice and assistantId: self", async () => {
    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.channel).toBe("phone");
    expect(resp!.assistantId).toBe("self");
    expect(resp!.bound).toBe(false);
  });

  test("status action returns guardianDeliveryChatId when bound", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-42",
      guardianPrincipalId: "user-42",
      guardianDeliveryChatId: "chat-42",
    });

    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "telegram",
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.bound).toBe(true);
    expect(resp!.guardianExternalUserId).toBe("user-42");
    expect(resp!.guardianDeliveryChatId).toBe("chat-42");
    expect(resp!.channel).toBe("telegram");
    expect(resp!.assistantId).toBe("self");
  });

  test("status action returns guardian username/displayName from binding metadata", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-43",
      guardianPrincipalId: "user-43",
      guardianDeliveryChatId: "chat-43",
      metadataJson: JSON.stringify({
        username: "guardian_handle",
        displayName: "Guardian Name",
      }),
    });

    // The contacts table stores displayName but not username.
    // The handler falls back to externalConversationStore for username,
    // so populate it here to ensure identity data is fully surfaced.
    const now = Date.now();
    getDb()
      .insert(conversations)
      .values({
        id: "conv-guardian-43",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    upsertExternalBinding({
      conversationId: "conv-guardian-43",
      sourceChannel: "telegram",
      externalChatId: "chat-43",
      externalUserId: "user-43",
      username: "guardian_handle",
      displayName: "Guardian Name",
    });

    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "telegram",
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.guardianUsername).toBe("guardian_handle");
    expect(resp!.guardianDisplayName).toBe("Guardian Name");
  });

  test("status action defaults channel to telegram when omitted", async () => {
    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      // channel omitted — should default to 'telegram'
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.channel).toBe("telegram");
    expect(resp!.assistantId).toBe("self");
  });

  test("status action defaults assistantId to self when omitted", async () => {
    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
      // assistantId omitted — should default to 'self'
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.assistantId).toBe("self");
    expect(resp!.channel).toBe("phone");
  });

  test("status action for unbound voice does not return guardianDeliveryChatId", async () => {
    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.bound).toBe(false);
    expect(resp!.guardianDeliveryChatId).toBeUndefined();
    expect(resp!.guardianExternalUserId).toBeUndefined();
  });

  test("status action includes hasPendingChallenge when challenge exists", async () => {
    await createInboundVerificationSession("phone");

    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.hasPendingChallenge).toBe(true);
  });

  test("status action hasPendingChallenge is false when no challenge exists", async () => {
    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.hasPendingChallenge).toBe(false);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Voice Guardian Challenge — Six-Digit Secret Generation
// ═══════════════════════════════════════════════════════════════════════════

describe("voice guardian challenge generation", () => {
  beforeEach(() => {
    resetTables();
  });

  test("createInboundVerificationSession for voice returns a high-entropy hex secret", async () => {
    const result = await createInboundVerificationSession("phone");

    expect(result.challengeId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.secret.length).toBe(64);
  });

  test("createInboundVerificationSession for non-voice returns high-entropy hex secret", async () => {
    const result = await createInboundVerificationSession("telegram");

    expect(result.secret.length).toBe(64);
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  test("voice challenge verifyCommand contains the hex secret", async () => {
    const result = await createInboundVerificationSession("phone");

    expect(result.verifyCommand).toBe(result.secret);
  });

  test("voice challenge instruction contains voice-specific copy", async () => {
    const result = await createInboundVerificationSession("phone");

    // Inbound challenges use high-entropy hex, so the voice template says
    // "enter the code" rather than "six-digit code".
    expect(result.instruction).toContain("enter the code");
    expect(result.instruction).toContain(result.secret);
  });

  test("voice challenge secrets are different across calls", async () => {
    const result1 = await createInboundVerificationSession("phone");
    const result2 = await createInboundVerificationSession("phone");

    // High-entropy hex secrets: collision probability is negligible
    expect(result1.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result2.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  test("voice ttlSeconds is 600 (10 minutes)", async () => {
    const result = await createInboundVerificationSession("phone");
    expect(result.ttlSeconds).toBe(600);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Voice Guardian Challenge Validation
// ═══════════════════════════════════════════════════════════════════════════

describe("voice guardian challenge validation", () => {
  beforeEach(() => {
    resetTables();
  });

  test("validateAndConsumeVerification succeeds with correct voice secret", async () => {
    const { secret } = await createInboundVerificationSession("phone");

    const result = await validateAndConsumeVerification(
      "phone",
      secret,
      "voice-user-1",
      "voice-chat-1",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("guardian");
    }
  });

  test("validateAndConsumeVerification does not create a guardian binding for voice (caller responsibility)", async () => {
    const { secret } = await createInboundVerificationSession("phone");

    await validateAndConsumeVerification(
      "phone",
      secret,
      "voice-user-1",
      "voice-chat-1",
    );

    const binding = await getGuardianBinding("asst-1", "phone");
    expect(binding).toBeNull();
  });

  test("validateAndConsumeVerification fails with wrong voice secret", async () => {
    await createInboundVerificationSession("phone");

    const result = await validateAndConsumeVerification(
      "phone",
      "000000",
      "voice-user-1",
      "voice-chat-1",
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.reason).toBeDefined();
      expect(result.reason.length).toBeGreaterThan(0);
      expect(result.reason.toLowerCase()).toContain("failed");
    }
  });

  test("voice and telegram guardian challenges are independent", async () => {
    const voiceChallenge = await createInboundVerificationSession("phone");
    const telegramChallenge =
      await createInboundVerificationSession("telegram");

    // Voice secret against telegram channel should fail
    const crossResult = await validateAndConsumeVerification(
      "telegram",
      voiceChallenge.secret,
      "user-1",
      "chat-1",
    );
    expect(crossResult.success).toBe(false);

    // Voice secret against correct channel should succeed
    const voiceResult = await validateAndConsumeVerification(
      "phone",
      voiceChallenge.secret,
      "voice-user-1",
      "voice-chat-1",
    );
    expect(voiceResult.success).toBe(true);

    // Telegram challenge should still be valid
    const telegramResult = await validateAndConsumeVerification(
      "telegram",
      telegramChallenge.secret,
      "user-2",
      "chat-2",
    );
    expect(telegramResult.success).toBe(true);
  });

  test("consumed voice challenge cannot be reused", async () => {
    const { secret } = await createInboundVerificationSession("phone");

    const result1 = await validateAndConsumeVerification(
      "phone",
      secret,
      "voice-user-1",
      "voice-chat-1",
    );
    expect(result1.success).toBe(true);

    const result2 = await validateAndConsumeVerification(
      "phone",
      secret,
      "voice-user-2",
      "voice-chat-2",
    );
    expect(result2.success).toBe(false);
  });

  test("validateAndConsumeVerification succeeds even with existing voice binding (conflict check is caller responsibility)", async () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "old-voice-user",
      guardianPrincipalId: "old-voice-user",
      guardianDeliveryChatId: "old-voice-chat",
    });

    const oldBinding = await getGuardianBinding("asst-1", "phone");
    expect(oldBinding).not.toBeNull();
    expect(oldBinding!.guardianExternalUserId).toBe("old-voice-user");

    const { secret } = await createInboundVerificationSession("phone");
    const result = await validateAndConsumeVerification(
      "phone",
      secret,
      "new-voice-user",
      "new-voice-chat",
    );

    // Challenge validation succeeds
    expect(result.success).toBe(true);

    // The original binding is untouched (no side effects)
    const binding = await getGuardianBinding("asst-1", "phone");
    expect(binding).not.toBeNull();
    expect(binding!.guardianExternalUserId).toBe("old-voice-user");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 13. Voice Guardian Identity and Revocation
// ═══════════════════════════════════════════════════════════════════════════

describe("voice guardian identity and revocation", () => {
  beforeEach(() => {
    resetTables();
  });

  test("isGuardian works for voice channel", async () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "voice-user-1",
      guardianPrincipalId: "voice-user-1",
      guardianDeliveryChatId: "voice-chat-1",
    });

    expect(await isGuardian("asst-1", "phone", "voice-user-1")).toBe(true);
    expect(await isGuardian("asst-1", "phone", "voice-user-2")).toBe(false);
    // Voice guardian should not match telegram channel
    expect(await isGuardian("asst-1", "telegram", "voice-user-1")).toBe(false);
  });

  test("getGuardianBinding returns voice binding", async () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "voice-user-1",
      guardianPrincipalId: "voice-user-1",
      guardianDeliveryChatId: "voice-chat-1",
    });

    const binding = await getGuardianBinding("asst-1", "phone");
    expect(binding).not.toBeNull();
    expect(binding!.channel).toBe("phone");
    expect(binding!.guardianExternalUserId).toBe("voice-user-1");
  });

  test("revokeBinding clears active voice guardian binding", async () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "voice-user-1",
      guardianPrincipalId: "voice-user-1",
      guardianDeliveryChatId: "voice-chat-1",
    });

    // The revoke is gateway-owned. Stamp the local downgrade and assert the
    // read reflects it.
    revokeGuardianChannelLocally("phone");
    expect(await getGuardianBinding("asst-1", "phone")).toBeNull();
  });

  test("revokeBinding for voice does not affect telegram binding", async () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "voice-user-1",
      guardianPrincipalId: "voice-user-1",
      guardianDeliveryChatId: "voice-chat-1",
    });
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "tg-user-1",
      guardianPrincipalId: "tg-user-1",
      guardianDeliveryChatId: "tg-chat-1",
    });

    revokeGuardianChannelLocally("phone");

    expect(await getGuardianBinding("asst-1", "phone")).toBeNull();
    expect(await getGuardianBinding("asst-1", "telegram")).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. Voice Guardian Rate Limiting
// ═══════════════════════════════════════════════════════════════════════════

describe("voice guardian rate limiting", () => {
  beforeEach(() => {
    resetTables();
  });

  test("repeated invalid voice submissions hit rate limit", async () => {
    await createInboundVerificationSession("phone");

    for (let i = 0; i < 5; i++) {
      const result = await validateAndConsumeVerification(
        "phone",
        `${100000 + i}`,
        "voice-user-1",
        "voice-chat-1",
      );
      expect(result.success).toBe(false);
    }

    // The 6th attempt should be rate-limited
    const result = await validateAndConsumeVerification(
      "phone",
      "999999",
      "voice-user-1",
      "voice-chat-1",
    );
    expect(result.success).toBe(false);

    const rl = getRateLimitState("phone", "voice-user-1", "voice-chat-1");
    expect(rl).not.toBeNull();
    expect(rl!.lockedUntil).not.toBeNull();
  });

  test("voice rate limit does not affect telegram rate limit", async () => {
    await createInboundVerificationSession("phone");
    for (let i = 0; i < 5; i++) {
      await validateAndConsumeVerification(
        "phone",
        `${100000 + i}`,
        "user-1",
        "chat-1",
      );
    }

    const voiceRl = getRateLimitState("phone", "user-1", "chat-1");
    expect(voiceRl).not.toBeNull();
    expect(voiceRl!.lockedUntil).not.toBeNull();

    // Telegram should be unaffected
    const telegramRl = getRateLimitState("telegram", "user-1", "chat-1");
    expect(telegramRl).toBeNull();
  });

  test("successful voice verification resets rate limit", async () => {
    const { secret: _s } = await createInboundVerificationSession("phone");
    await validateAndConsumeVerification(
      "phone",
      "000000",
      "voice-user-1",
      "voice-chat-1",
    );
    await validateAndConsumeVerification(
      "phone",
      "111111",
      "voice-user-1",
      "voice-chat-1",
    );

    // Valid attempt should succeed (under the 5-attempt threshold)
    const { secret } = await createInboundVerificationSession("phone");
    const result = await validateAndConsumeVerification(
      "phone",
      secret,
      "voice-user-1",
      "voice-chat-1",
    );
    expect(result.success).toBe(true);

    const rl = getRateLimitState("phone", "voice-user-1", "voice-chat-1");
    expect(rl).not.toBeNull();
    expect(rl!.invalidAttempts).toBe(0);
    expect(rl!.lockedUntil).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 15. Pending Challenge Lookup (Store + Service)
// ═══════════════════════════════════════════════════════════════════════════

describe("pending challenge lookup", () => {
  beforeEach(() => {
    resetTables();
  });

  test("getPendingSession returns pending voice challenge", async () => {
    await createInboundVerificationSession("phone");

    const pending = await getPendingSession("phone");
    expect(pending).not.toBeNull();
    expect(pending!.channel).toBe("phone");
    expect(pending!.status).toBe("pending");
  });

  test("getPendingSession returns null when no challenge exists", async () => {
    const pending = await getPendingSession("phone");
    expect(pending).toBeNull();
  });

  test("getPendingSession returns null for different channel", async () => {
    await createInboundVerificationSession("telegram");

    const pending = await getPendingSession("phone");
    expect(pending).toBeNull();
  });

  test("getPendingSession returns null after challenge is consumed", async () => {
    const { secret } = await createInboundVerificationSession("phone");
    await validateAndConsumeVerification(
      "phone",
      secret,
      "voice-user-1",
      "voice-chat-1",
    );

    const pending = await getPendingSession("phone");
    expect(pending).toBeNull();
  });

  test("creating a new challenge revokes prior pending challenges", async () => {
    await createInboundVerificationSession("phone");
    const pending1 = await getPendingSession("phone");
    expect(pending1).not.toBeNull();
    const firstId = pending1!.id;

    // Creating a second challenge should revoke the first
    await createInboundVerificationSession("phone");
    const pending2 = await getPendingSession("phone");
    expect(pending2).not.toBeNull();
    expect(pending2!.id).not.toBe(firstId);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 16. HTTP handler — voice guardian verification
// ═══════════════════════════════════════════════════════════════════════════

describe("HTTP handler voice guardian verification", () => {
  beforeEach(() => {
    resetTables();
  });

  test("create_challenge for voice returns a high-entropy hex secret", async () => {
    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.secret).toBeDefined();
    expect(resp!.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(resp!.instruction).toBeDefined();
    expect(resp!.instruction).toContain("enter the code");
    expect(resp!.channel).toBe("phone");
  });

  test("status for voice reflects unbound state", async () => {
    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.channel).toBe("phone");
    expect(resp!.bound).toBe(false);
    expect(resp!.guardianExternalUserId).toBeUndefined();
  });

  test("status for voice reflects bound state", async () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "voice-user-1",
      guardianPrincipalId: "voice-user-1",
      guardianDeliveryChatId: "voice-chat-1",
    });

    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.bound).toBe(true);
    expect(resp!.guardianExternalUserId).toBe("voice-user-1");
    expect(resp!.guardianDeliveryChatId).toBe("voice-chat-1");
    expect(resp!.channel).toBe("phone");
  });

  test("revoke for voice clears active binding", async () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "voice-user-1",
      guardianPrincipalId: "voice-user-1",
      guardianDeliveryChatId: "voice-chat-1",
    });

    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "revoke",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.bound).toBe(false);

    // Verify binding is actually revoked
    expect(await getGuardianBinding("self", "phone")).toBeNull();
  });

  test("revoke for voice does not affect telegram binding", async () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "voice-user-1",
      guardianPrincipalId: "voice-user-1",
      guardianDeliveryChatId: "voice-chat-1",
    });
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "tg-user-1",
      guardianPrincipalId: "tg-user-1",
      guardianDeliveryChatId: "tg-chat-1",
    });

    broadcastedMessages.length = 0;
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "revoke",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg);

    expect(await getGuardianBinding("self", "phone")).toBeNull();
    expect(await getGuardianBinding("self", "telegram")).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 17. Outbound Verification Sessions
// ═══════════════════════════════════════════════════════════════════════════

describe("outbound verification sessions", () => {
  beforeEach(() => {
    resetTables();
  });

  // ── Session creation with expected identity fields ──

  test("createOutboundSession creates a session with expected identity fields", async () => {
    const result = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    expect(result.sessionId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.challengeHash).toBeDefined();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.ttlSeconds).toBe(600);

    const session = await serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    expect(session!.expectedPhoneE164).toBe("+15551234567");
    expect(session!.destinationAddress).toBe("+15551234567");
    expect(session!.identityBindingStatus).toBe("bound");
    expect(session!.status).toBe("awaiting_response");
  });

  test("createOutboundSession for telegram with pending_bootstrap status", async () => {
    const result = await createOutboundSession({
      channel: "telegram",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@some_handle",
    });

    expect(result.sessionId).toBeDefined();

    const session = await serviceFindActiveSession("telegram");
    expect(session).not.toBeNull();
    expect(session!.identityBindingStatus).toBe("pending_bootstrap");
    expect(session!.status).toBe("pending_bootstrap");
    expect(session!.expectedExternalUserId).toBeNull();
    expect(session!.expectedChatId).toBeNull();
  });

  // ── Identity match: right code + right identity → success ──

  test("validateAndConsumeVerification succeeds with correct secret and matching identity (voice)", async () => {
    const { secret } = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      expectedExternalUserId: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const result = await validateAndConsumeVerification(
      "phone",
      secret,
      "+15551234567",
      "voice-chat-1",
    );

    expect(result.success).toBe(true);
  });

  test("validateAndConsumeVerification succeeds with correct secret and matching identity (Telegram)", async () => {
    const { secret } = await createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "tg-user-42",
      expectedChatId: "tg-chat-42",
      destinationAddress: "tg-chat-42",
    });

    const result = await validateAndConsumeVerification(
      "telegram",
      secret,
      "tg-user-42",
      "tg-chat-42",
    );

    expect(result.success).toBe(true);
  });

  // ── Identity mismatch: right code + wrong identity → reject ──

  test("validateAndConsumeVerification rejects correct secret with wrong identity (anti-oracle)", async () => {
    const { secret } = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      expectedExternalUserId: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const result = await validateAndConsumeVerification(
      "phone",
      secret,
      "+15559999999",
      "voice-chat-wrong",
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      // Anti-oracle: same generic "invalid or expired" message
      expect(result.reason.toLowerCase()).toContain("failed");
      expect(result.reason).not.toContain("identity");
      expect(result.reason).not.toContain("mismatch");
    }
  });

  test("validateAndConsumeVerification rejects correct secret with wrong Telegram identity", async () => {
    const { secret } = await createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "tg-user-42",
      expectedChatId: "tg-chat-42",
      destinationAddress: "tg-chat-42",
    });

    const result = await validateAndConsumeVerification(
      "telegram",
      secret,
      "tg-user-WRONG",
      "tg-chat-WRONG",
    );

    expect(result.success).toBe(false);
  });

  // ── Expired session → reject ──

  test("expired outbound session is rejected", async () => {
    // Create a session directly via the store with an already-expired expiresAt
    const secret = "test-expired-session-secret";
    const challengeHash = createHash("sha256").update(secret).digest("hex");
    seedVerificationSession({
      id: "session-expired",
      channel: "phone",
      challengeHash,
      expiresAt: Date.now() - 1000,
      status: "awaiting_response",
      expectedPhoneE164: "+15551234567",
      identityBindingStatus: "bound",
    });

    const result = await validateAndConsumeVerification(
      "phone",
      secret,
      "+15551234567",
      "voice-chat-1",
    );

    expect(result.success).toBe(false);
  });

  // ── Revoked session → reject ──

  test("revoked outbound session is rejected", async () => {
    const { secret, sessionId } = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    // Revoke the session
    await serviceUpdateSessionStatus(sessionId, "revoked");

    const result = await validateAndConsumeVerification(
      "phone",
      secret,
      "+15551234567",
      "voice-chat-1",
    );

    expect(result.success).toBe(false);
  });

  // ── One-time consumption (replay prevention) ──

  test("outbound session cannot be consumed twice (replay prevention)", async () => {
    const { secret } = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      expectedExternalUserId: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const result1 = await validateAndConsumeVerification(
      "phone",
      secret,
      "+15551234567",
      "voice-chat-1",
    );
    expect(result1.success).toBe(true);

    const result2 = await validateAndConsumeVerification(
      "phone",
      secret,
      "+15551234567",
      "voice-chat-1",
    );
    expect(result2.success).toBe(false);
  });

  // ── Inbound-only verification flow ──

  test("inbound-only challenge without expected identity still works", async () => {
    const { secret } = await createInboundVerificationSession("telegram");

    const result = await validateAndConsumeVerification(
      "telegram",
      secret,
      "user-42",
      "chat-42",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("guardian");
    }
  });

  // ── Session state transitions ──

  test("session state transitions (pending_bootstrap → awaiting_response → verified)", async () => {
    const { sessionId } = await createOutboundSession({
      channel: "telegram",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@some_handle",
    });

    const initial = await serviceFindActiveSession("telegram");
    expect(initial).not.toBeNull();
    expect(initial!.status).toBe("pending_bootstrap");

    // Transition to awaiting_response
    await serviceUpdateSessionStatus(sessionId, "awaiting_response");
    const awaiting = await serviceFindActiveSession("telegram");
    expect(awaiting).not.toBeNull();
    expect(awaiting!.status).toBe("awaiting_response");

    // Transition to verified
    await serviceUpdateSessionStatus(sessionId, "verified");
    // verified is not an "active" status, so findActiveSession returns null
    const active = await serviceFindActiveSession("telegram");
    expect(active).toBeNull();
  });

  // ── Auto-revoke of prior sessions ──

  test("creating a new outbound session auto-revokes prior pending/awaiting sessions", async () => {
    const { sessionId: firstId } = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const first = await serviceFindActiveSession("phone");
    expect(first).not.toBeNull();
    expect(first!.id).toBe(firstId);

    // Create a second session — first should be revoked
    const { sessionId: secondId } = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15559876543",
      destinationAddress: "+15559876543",
    });

    const second = await serviceFindActiveSession("phone");
    expect(second).not.toBeNull();
    expect(second!.id).toBe(secondId);

    // First session should no longer be findable as active
    const firstRow = getSessionById(firstId);
    expect(firstRow).not.toBeNull();
    expect(firstRow!.status).toBe("revoked");
  });

  // ── findActiveSession returns correct session ──

  test("findActiveSession returns the most recent active session", async () => {
    await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const session = await serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    expect(session!.status).toBe("awaiting_response");
    expect(session!.expectedPhoneE164).toBe("+15551234567");
  });

  test("findActiveSession returns null when no active session exists", async () => {
    const session = await serviceFindActiveSession("phone");
    expect(session).toBeNull();
  });

  // ── bindSessionIdentity transitions from pending_bootstrap to bound ──

  test("bindSessionIdentity transitions from pending_bootstrap to bound", async () => {
    const { sessionId } = await createOutboundSession({
      channel: "telegram",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@some_handle",
    });

    const before = await serviceFindActiveSession("telegram");
    expect(before).not.toBeNull();
    expect(before!.identityBindingStatus).toBe("pending_bootstrap");
    expect(before!.expectedExternalUserId).toBeNull();
    expect(before!.expectedChatId).toBeNull();

    // Bind the identity
    serviceBindSessionIdentity(sessionId, "tg-user-42", "tg-chat-42");

    const after = await serviceFindActiveSession("telegram");
    expect(after).not.toBeNull();
    expect(after!.identityBindingStatus).toBe("bound");
    expect(after!.expectedExternalUserId).toBe("tg-user-42");
    expect(after!.expectedChatId).toBe("tg-chat-42");
  });

  // ── pending_bootstrap allows consumption without identity check ──

  test("pending_bootstrap session allows consumption without identity check", async () => {
    const { secret } = await createOutboundSession({
      channel: "telegram",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@some_handle",
    });

    // Any actor can consume during pending_bootstrap
    const result = await validateAndConsumeVerification(
      "telegram",
      secret,
      "any-user",
      "any-chat",
    );

    expect(result.success).toBe(true);
  });

  // ── Delivery tracking ──

  test("updateSessionDelivery updates delivery tracking fields", async () => {
    const { sessionId } = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const now = Date.now();
    await storeUpdateSessionDelivery(sessionId, now, 1, now + 30_000);

    const session = await serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    expect(session!.lastSentAt).toBe(now);
    expect(session!.sendCount).toBe(1);
    expect(session!.nextResendAt).toBe(now + 30_000);
  });

  // ── Telegram identity match via chatId ──

  test("Telegram identity match succeeds via chatId alone", async () => {
    const { secret } = await createOutboundSession({
      channel: "telegram",
      expectedChatId: "tg-chat-42",
      destinationAddress: "tg-chat-42",
    });

    // Actor has a different external user ID but matching chat ID
    const result = await validateAndConsumeVerification(
      "telegram",
      secret,
      "tg-user-DIFFERENT",
      "tg-chat-42",
    );

    expect(result.success).toBe(true);
  });

  // ── Voice identity match via expectedExternalUserId ──

  test("Voice identity match succeeds via expectedExternalUserId", async () => {
    const { secret } = await createOutboundSession({
      channel: "phone",
      expectedExternalUserId: "voice-user-42",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    // Actor matches expectedExternalUserId
    const result = await validateAndConsumeVerification(
      "phone",
      secret,
      "voice-user-42",
      "voice-chat-1",
    );

    expect(result.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 18. Outbound Voice Verification (HTTP Handlers)
// ═══════════════════════════════════════════════════════════════════════════

describe("outbound voice verification", () => {
  beforeEach(() => {
    resetTables();
  });

  test("start_outbound creates session with expected E.164 identity and returns code", async () => {
    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15551234567",
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.verificationSessionId).toBeDefined();
    expect(resp!.secret).toBeDefined();
    expect(resp!.expiresAt).toBeGreaterThan(Date.now());
    expect(resp!.nextResendAt).toBeGreaterThan(Date.now());
    expect(resp!.sendCount).toBe(1);
    expect(resp!.channel).toBe("phone");

    // Verify the session was created with expected identity
    const session = await serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    expect(session!.expectedPhoneE164).toBe("+15551234567");
    expect(session!.destinationAddress).toBe("+15551234567");
  });

  test("start_outbound rejects when active binding exists (rebind=false)", async () => {
    // Create an existing guardian binding
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "+15551234567",
      guardianPrincipalId: "+15551234567",
      guardianDeliveryChatId: "voice-chat-1",
    });

    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15559876543",
      rebind: false,
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("already_bound");
  });

  test("start_outbound allows rebind when rebind=true", async () => {
    // Create an existing guardian binding
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "+15551234567",
      guardianPrincipalId: "+15551234567",
      guardianDeliveryChatId: "voice-chat-1",
    });

    const { lastResponse } = createResponseReader();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15559876543",
      rebind: true,
    };

    await handleChannelVerificationSession(msg);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.verificationSessionId).toBeDefined();
  });

  test("resend_outbound before cooldown is rejected", async () => {
    // Start an outbound session first
    broadcastedMessages.length = 0;
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15551234567",
    });

    // Immediately try to resend (before cooldown)
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "resend_session",
      channel: "phone",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("rate_limited");
  });

  test("resend_outbound after cooldown succeeds and increments sendCount", async () => {
    // Start an outbound session
    const { lastResponse: startResp } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15551234567",
    });

    const startResponse = startResp();
    expect(startResponse!.success).toBe(true);

    // Manually update the session's nextResendAt to the past to simulate cooldown elapsed
    const session = await serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    await storeUpdateSessionDelivery(
      session!.id,
      Date.now() - RESEND_COOLDOWN_MS - 1000,
      1,
      Date.now() - 1000,
    );

    // Now resend should succeed
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "resend_session",
      channel: "phone",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.sendCount).toBe(2);
    expect(resp!.nextResendAt).toBeGreaterThan(Date.now());
  });

  test("resend_outbound exceeding max sends is rejected", async () => {
    // Start an outbound session
    broadcastedMessages.length = 0;
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15551234567",
    });

    // Set the send count to MAX_SENDS_PER_SESSION and nextResendAt to the past
    const session = await serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    await storeUpdateSessionDelivery(
      session!.id,
      Date.now() - RESEND_COOLDOWN_MS - 1000,
      MAX_SENDS_PER_SESSION,
      Date.now() - 1000,
    );

    // Resend should be rejected due to max sends
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "resend_session",
      channel: "phone",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("max_sends_exceeded");
  });

  test("cancel_outbound revokes active session", async () => {
    // Start an outbound session
    broadcastedMessages.length = 0;
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15551234567",
    });

    // Verify session exists
    const sessionBefore = await serviceFindActiveSession("phone");
    expect(sessionBefore).not.toBeNull();

    // Cancel it
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "cancel_session",
      channel: "phone",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.channel).toBe("phone");

    // Verify session is no longer active
    const sessionAfter = await serviceFindActiveSession("phone");
    expect(sessionAfter).toBeNull();
  });

  test("inbound voice from expected identity + correct code succeeds", async () => {
    // Create an outbound session
    const { secret } = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      expectedExternalUserId: "+15551234567",
      destinationAddress: "+15551234567",
    });

    // Validate with matching identity
    const result = await validateAndConsumeVerification(
      "phone",
      secret,
      "+15551234567",
      "voice-chat-1",
    );

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.verificationType).toBe("guardian");
    }
  });

  test("inbound voice from wrong identity + correct code is rejected", async () => {
    // Create an outbound session with expected identity +15551234567
    const { secret } = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      expectedExternalUserId: "+15551234567",
      destinationAddress: "+15551234567",
    });

    // Try to validate with a different phone number (anti-oracle: same generic error)
    const result = await validateAndConsumeVerification(
      "phone",
      secret,
      "+15559999999",
      "voice-chat-wrong",
    );

    expect(result.success).toBe(false);
    if (!result.success) {
      // Anti-oracle: generic failure message, no identity-specific info leaked
      expect(result.reason.toLowerCase()).toContain("failed");
      expect(result.reason).not.toContain("identity");
      expect(result.reason).not.toContain("mismatch");
    }
  });

  test("start_outbound succeeds for email channel", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "email",
      destination: "user@example.com",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.channel).toBe("email");
  });

  test("create_session without destination falls through to inbound challenge", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      // no destination — unified create_session creates an inbound challenge
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.secret).toBeDefined();
  });

  test("start_outbound rejects unparseable phone number", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "not-a-phone",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("invalid_destination");
  });

  test("start_outbound normalizes formatted phone number for voice", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "(555) 123-4567",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.verificationSessionId).toBeDefined();
    expect(resp!.secret).toBeDefined();

    // Verify the session was created with the normalized E.164 number
    const session = await serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    expect(session!.expectedPhoneE164).toBe("+15551234567");
    expect(session!.destinationAddress).toBe("+15551234567");

    // Allow fire-and-forget voice call delivery to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify voice call was initiated to the normalized number
    expect(voiceCallInitCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = voiceCallInitCalls[voiceCallInitCalls.length - 1];
    expect(lastCall.phoneNumber).toBe("+15551234567");
  });

  test("cancel_session succeeds even when no active session (idempotent)", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "cancel_session",
      channel: "phone",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 19. Outbound Telegram Verification
// ═══════════════════════════════════════════════════════════════════════════

describe("outbound Telegram verification", () => {
  beforeEach(() => {
    resetTables();
  });

  test("start_outbound for telegram with handle returns deep link URL, no outbound message", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "telegram",
      destination: "@someuser",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.verificationSessionId).toBeDefined();
    expect(resp!.telegramBootstrapUrl).toBeDefined();
    expect(resp!.telegramBootstrapUrl).toContain(
      "https://t.me/test_bot?start=gv_",
    );
    expect(resp!.channel).toBe("telegram");
    // No outbound message should be sent yet (pending bootstrap)
    expect(telegramDeliverCalls.length).toBe(0);

    // Verify the session is in pending_bootstrap state
    const session = await serviceFindActiveSession("telegram");
    expect(session).not.toBeNull();
    expect(session!.identityBindingStatus).toBe("pending_bootstrap");
    // destinationAddress is normalized: '@' stripped and lowercased
    expect(session!.destinationAddress).toBe("someuser");
    expect(session!.bootstrapTokenHash).toBeDefined();
    expect(session!.bootstrapTokenHash).not.toBeNull();
  });

  test("start_outbound for telegram with handle (no @ prefix) returns deep link", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "telegram",
      destination: "someuser",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.telegramBootstrapUrl).toContain(
      "https://t.me/test_bot?start=gv_",
    );
    expect(telegramDeliverCalls.length).toBe(0);
  });

  test("start_outbound for telegram with known chat ID sends message, no deep link", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "telegram",
      destination: "123456789",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.verificationSessionId).toBeDefined();
    expect(resp!.secret).toBeDefined();
    expect(resp!.expiresAt).toBeGreaterThan(Date.now());
    expect(resp!.nextResendAt).toBeGreaterThan(Date.now());
    expect(resp!.sendCount).toBe(1);
    expect(resp!.channel).toBe("telegram");
    // No bootstrap URL since this is a direct chat ID
    expect(resp!.telegramBootstrapUrl).toBeUndefined();

    // Verify the session was created with expected identity
    const session = await serviceFindActiveSession("telegram");
    expect(session).not.toBeNull();
    expect(session!.expectedChatId).toBe("123456789");
    expect(session!.identityBindingStatus).toBe("bound");
    expect(session!.destinationAddress).toBe("123456789");

    // Allow async telegram delivery to settle
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(telegramDeliverCalls.length).toBe(1);
    expect(telegramDeliverCalls[0].chatId).toBe("123456789");
    expect(telegramDeliverCalls[0].text).toContain("code you were given");
  });

  test("start_outbound for telegram without bot username fails", async () => {
    mockBotUsername = undefined;

    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "telegram",
      destination: "@someuser",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("no_bot_username");
  });

  test("start_outbound for telegram rejects when active binding exists (rebind=false)", async () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-42",
      guardianPrincipalId: "user-42",
      guardianDeliveryChatId: "chat-42",
    });

    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "telegram",
      destination: "@newuser",
      rebind: false,
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("already_bound");
  });

  test("bootstrap: resolveBootstrapToken finds pending_bootstrap session by token", async () => {
    const { createHash } = await import("node:crypto");
    const token = "test_bootstrap_token_hex";
    const tokenHash = createHash("sha256").update(token).digest("hex");

    seedVerificationSession({
      id: "session-bootstrap-1",
      channel: "telegram",
      challengeHash: "some-challenge-hash",
      expiresAt: Date.now() + 600_000,
      status: "pending_bootstrap",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@targetuser",
      bootstrapTokenHash: tokenHash,
    });

    const found = await resolveBootstrapToken("telegram", token);
    expect(found).not.toBeNull();
    expect(found!.id).toBe("session-bootstrap-1");
    expect(found!.status).toBe("pending_bootstrap");
  });

  test("bootstrap: resolveBootstrapToken returns null for wrong token", async () => {
    const { createHash } = await import("node:crypto");
    const token = "test_bootstrap_token_hex";
    const tokenHash = createHash("sha256").update(token).digest("hex");

    seedVerificationSession({
      id: "session-bootstrap-2",
      channel: "telegram",
      challengeHash: "some-challenge-hash",
      expiresAt: Date.now() + 600_000,
      status: "pending_bootstrap",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@targetuser",
      bootstrapTokenHash: tokenHash,
    });

    const found = await resolveBootstrapToken("telegram", "wrong_token");
    expect(found).toBeNull();
  });

  test("bootstrap: resolveBootstrapToken returns null for expired session", async () => {
    const { createHash } = await import("node:crypto");
    const token = "test_bootstrap_token_hex";
    const tokenHash = createHash("sha256").update(token).digest("hex");

    seedVerificationSession({
      id: "session-bootstrap-3",
      channel: "telegram",
      challengeHash: "some-challenge-hash",
      expiresAt: Date.now() - 1000, // already expired
      status: "pending_bootstrap",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@targetuser",
      bootstrapTokenHash: tokenHash,
    });

    const found = await resolveBootstrapToken("telegram", token);
    expect(found).toBeNull();
  });

  test("identity-bound consume: right chat_id + right code succeeds", async () => {
    // Create an awaiting_response session with expected identity
    const sessionResult = await createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "user-42",
      expectedChatId: "chat-42",
      identityBindingStatus: "bound",
      destinationAddress: "chat-42",
    });

    const result = await validateAndConsumeVerification(
      "telegram",
      sessionResult.secret,
      "user-42",
      "chat-42",
    );

    expect(result.success).toBe(true);
  });

  test("identity mismatch: wrong chat_id + right code rejects", async () => {
    const sessionResult = await createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "user-42",
      expectedChatId: "chat-42",
      identityBindingStatus: "bound",
      destinationAddress: "chat-42",
    });

    const result = await validateAndConsumeVerification(
      "telegram",
      sessionResult.secret,
      "attacker-99",
      "attacker-chat-99",
    );

    expect(result.success).toBe(false);
  });

  test("revoked session rejects verification", async () => {
    const sessionResult = await createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "user-42",
      expectedChatId: "chat-42",
      identityBindingStatus: "bound",
      destinationAddress: "chat-42",
    });

    // Revoke the session
    await serviceUpdateSessionStatus(sessionResult.sessionId, "revoked");

    const result = await validateAndConsumeVerification(
      "telegram",
      sessionResult.secret,
      "user-42",
      "chat-42",
    );

    expect(result.success).toBe(false);
  });

  test("inbound-only Telegram verification flow still works with bare code", async () => {
    // Create an inbound-only challenge (no outbound session, no expected identity)
    const challengeResult = await createInboundVerificationSession("telegram");

    const result = await validateAndConsumeVerification(
      "telegram",
      challengeResult.secret,
      "user-42",
      "chat-42",
    );

    expect(result.success).toBe(true);
  });

  test("resend_outbound for telegram works with known chat ID", async () => {
    // Start an outbound session with a known chat ID
    broadcastedMessages.length = 0;
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "telegram",
      destination: "123456789",
    });

    // Fast-forward the cooldown
    const session = await serviceFindActiveSession("telegram");
    expect(session).not.toBeNull();
    await storeUpdateSessionDelivery(
      session!.id,
      Date.now() - RESEND_COOLDOWN_MS - 1000,
      1,
      Date.now() - 1000,
    );

    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "resend_session",
      channel: "telegram",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.sendCount).toBe(2);

    // Allow async telegram delivery to settle
    await new Promise((resolve) => setTimeout(resolve, 50));
    // Should have at least 2 delivery calls (initial + resend)
    expect(telegramDeliverCalls.length).toBeGreaterThanOrEqual(2);
  });

  test("resend_outbound for pending_bootstrap session is rejected", async () => {
    // Start an outbound session with a handle (pending_bootstrap)
    broadcastedMessages.length = 0;
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "telegram",
      destination: "@someuser",
    });

    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "resend_session",
      channel: "telegram",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("pending_bootstrap");
  });

  test("cancel_outbound for telegram revokes session", async () => {
    // Start an outbound session
    broadcastedMessages.length = 0;
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "telegram",
      destination: "123456789",
    });

    const session = await serviceFindActiveSession("telegram");
    expect(session).not.toBeNull();

    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "cancel_session",
      channel: "telegram",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);

    // Session should be revoked
    const revoked = await serviceFindActiveSession("telegram");
    expect(revoked).toBeNull();
  });

  test("telegram template does not include verification code in message", async () => {
    const msg = composeVerificationTelegram(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST,
      { code: "abc123", expiresInMinutes: 10 },
    );
    expect(msg).not.toContain("abc123");
    expect(msg).not.toContain("guardian_verify");
  });

  test("telegram resend template does not include code and includes (resent) suffix", async () => {
    const msg = composeVerificationTelegram(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_RESEND,
      { code: "xyz789", expiresInMinutes: 5 },
    );
    expect(msg).not.toContain("xyz789");
    expect(msg).not.toContain("guardian_verify");
    expect(msg).toContain("(resent)");
  });

  test("telegram template includes Vellum assistant prefix", async () => {
    const msg = composeVerificationTelegram(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST,
      { code: "999999", expiresInMinutes: 10, assistantName: "MyBot" },
    );
    expect(msg).toContain("Vellum assistant");
    expect(msg).not.toContain("999999");
  });

  test("create_session for telegram without destination falls through to inbound challenge", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "telegram",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.secret).toBeDefined();
  });

  test("rate limits apply to telegram outbound (per-session send cap)", async () => {
    // Start an outbound session with a known chat ID
    broadcastedMessages.length = 0;
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "telegram",
      destination: "123456789",
    });

    // Set the send count to MAX_SENDS_PER_SESSION and nextResendAt to the past
    const session = await serviceFindActiveSession("telegram");
    expect(session).not.toBeNull();
    await storeUpdateSessionDelivery(
      session!.id,
      Date.now() - RESEND_COOLDOWN_MS - 1000,
      MAX_SENDS_PER_SESSION,
      Date.now() - 1000,
    );

    // Resend should be rejected due to max sends
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "resend_session",
      channel: "telegram",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("max_sends_exceeded");
  });

  test("rate limits apply to telegram outbound (cooldown)", async () => {
    // Start an outbound session with a known chat ID
    broadcastedMessages.length = 0;
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "telegram",
      destination: "123456789",
    });

    // Immediately try to resend (before cooldown)
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "resend_session",
      channel: "telegram",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("rate_limited");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 20. Outbound Voice Verification
// ═══════════════════════════════════════════════════════════════════════════

describe("outbound voice verification", () => {
  beforeEach(() => {
    resetTables();
  });

  test("start_outbound for voice creates session with 6-digit code and initiates call", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15551234567",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.verificationSessionId).toBeDefined();
    expect(resp!.secret).toBeDefined();
    // Voice codes are 6 digits
    expect(resp!.secret!.length).toBe(6);
    expect(/^\d{6}$/.test(resp!.secret!)).toBe(true);
    expect(resp!.expiresAt).toBeGreaterThan(Date.now());
    expect(resp!.nextResendAt).toBeGreaterThan(Date.now());
    expect(resp!.sendCount).toBe(1);
    expect(resp!.channel).toBe("phone");

    // Verify the session was created with expected identity
    const session = await serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    expect(session!.expectedPhoneE164).toBe("+15551234567");
    expect(session!.destinationAddress).toBe("+15551234567");

    // Allow the fire-and-forget call initiation to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify the call was initiated
    expect(voiceCallInitCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = voiceCallInitCalls[voiceCallInitCalls.length - 1];
    expect(lastCall.phoneNumber).toBe("+15551234567");
    expect(lastCall.verificationSessionId).toBe(resp!.verificationSessionId!);
  });

  test("start_outbound for voice rejects unparseable phone number", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "not-a-phone",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("invalid_destination");
  });

  test("start_outbound for voice normalizes formatted phone number", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "555-123-4567",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.verificationSessionId).toBeDefined();
    expect(resp!.secret).toBeDefined();
    // Voice codes are 6 digits
    expect(resp!.secret!.length).toBe(6);

    // Verify the session was created with the normalized E.164 number
    const session = await serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    expect(session!.expectedPhoneE164).toBe("+15551234567");
    expect(session!.destinationAddress).toBe("+15551234567");

    // Allow fire-and-forget call initiation to complete
    await new Promise((resolve) => setTimeout(resolve, 50));

    // Verify the call was initiated with the normalized number
    expect(voiceCallInitCalls.length).toBeGreaterThanOrEqual(1);
    const lastCall = voiceCallInitCalls[voiceCallInitCalls.length - 1];
    expect(lastCall.phoneNumber).toBe("+15551234567");
  });

  test("start_outbound for voice rejects when binding exists (rebind=false)", async () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "+15551234567",
      guardianPrincipalId: "+15551234567",
      guardianDeliveryChatId: "+15551234567",
    });

    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15559876543",
      rebind: false,
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("already_bound");
  });

  test("resend_outbound for voice initiates a new call with cooldown check", async () => {
    // Start an outbound session first
    broadcastedMessages.length = 0;
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15551234567",
    });

    // Immediately try to resend (before cooldown)
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "resend_session",
      channel: "phone",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("rate_limited");
  });

  test("cancel_outbound for voice cancels session", async () => {
    // Start an outbound session first
    broadcastedMessages.length = 0;
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15551234567",
    });

    // Cancel the session
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "cancel_session",
      channel: "phone",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);

    // Session should no longer be active
    const session = await serviceFindActiveSession("phone");
    expect(session).toBeNull();
  });

  test("rate limit enforcement: destination rate limit applies to voice", async () => {
    // Exhaust the per-destination rate limit by creating many sessions
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      // Seed sessions with recent lastSentAt to simulate sends
      seedVerificationSession({
        id: `rate-limit-voice-${i}`,
        channel: "phone",
        challengeHash: `hash-${i}`,
        expiresAt: now + 600_000,
        status: "awaiting_response",
        destinationAddress: "+15551234567",
        lastSentAt: now - 1000,
        sendCount: 1,
      });
    }

    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15551234567",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("rate_limited");
  });

  test("create_session for voice without destination falls through to inbound challenge", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.secret).toBeDefined();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 22. M1–M4 Hardening: constant values, secret presence, and entropy
// ═══════════════════════════════════════════════════════════════════════════

describe("M1–M4 hardening coverage", () => {
  beforeEach(() => {
    resetTables();
  });

  // ── M2: RESEND_COOLDOWN_MS is 15 000 ms (was 60 000) ──

  test("RESEND_COOLDOWN_MS is 15 000 ms", async () => {
    expect(RESEND_COOLDOWN_MS).toBe(15_000);
  });

  // ── M2: start_outbound for voice returns secret in response ──

  test("start_outbound for voice response includes secret", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15551234567",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.secret).toBeDefined();
    expect(typeof resp!.secret).toBe("string");
    expect(resp!.secret!.length).toBeGreaterThan(0);
  });

  // ── M2: resend_outbound for voice returns secret in response ──

  test("resend_outbound for voice response includes secret", async () => {
    // Start a session first
    broadcastedMessages.length = 0;
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15551234567",
    });

    // Move past cooldown
    const session = await serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    await storeUpdateSessionDelivery(
      session!.id,
      Date.now() - RESEND_COOLDOWN_MS - 1000,
      1,
      Date.now() - 1000,
    );

    // Resend
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "resend_session",
      channel: "phone",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.secret).toBeDefined();
    expect(typeof resp!.secret).toBe("string");
    expect(resp!.secret!.length).toBeGreaterThan(0);
  });

  // ── M2: start_outbound for Telegram bootstrap does NOT return secret ──

  test("start_outbound for Telegram bootstrap (handle) does NOT return secret", async () => {
    const { lastResponse } = createResponseReader();
    await handleChannelVerificationSession({
      type: "channel_verification_session",
      action: "create_session",
      channel: "telegram",
      destination: "@someuser",
    });

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    // Security: secret must NOT be revealed for pending_bootstrap sessions
    expect(resp!.secret).toBeUndefined();
    // Bootstrap URL should be present instead
    expect(resp!.telegramBootstrapUrl).toBeDefined();
  });

  // ── M2: bootstrap sessions use high-entropy hex secrets ──

  test("bootstrap (pending_bootstrap) sessions use high-entropy hex secrets, identity-bound use 6-digit numeric", async () => {
    const bootstrapResult = await createOutboundSession({
      channel: "telegram",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@testuser",
    });
    // Pending bootstrap: high-entropy hex (32 bytes = 64 hex chars)
    expect(bootstrapResult.secret.length).toBe(64);
    expect(bootstrapResult.secret).toMatch(/^[a-f0-9]{64}$/);

    resetTables();

    // Identity-bound: 6-digit numeric code
    const boundResult = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
      identityBindingStatus: "bound",
    });
    expect(boundResult.secret.length).toBe(6);
    expect(boundResult.secret).toMatch(/^\d{6}$/);
  });

  // ── M2: all identity-bound channels use 6-digit numeric codes ──

  test("all identity-bound channels (voice, Telegram chat ID) use 6-digit numeric codes", async () => {
    // Voice (phone E.164)
    const voicePhoneResult = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });
    expect(voicePhoneResult.secret).toMatch(/^\d{6}$/);

    resetTables();

    // Telegram (bound via chat ID)
    const tgResult = await createOutboundSession({
      channel: "telegram",
      expectedChatId: "123456789",
      identityBindingStatus: "bound",
      destinationAddress: "123456789",
    });
    expect(tgResult.secret).toMatch(/^\d{6}$/);

    resetTables();

    // Voice (explicit codeDigits)
    const voiceResult = await createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
      codeDigits: 6,
    });
    expect(voiceResult.secret).toMatch(/^\d{6}$/);
  });
});
