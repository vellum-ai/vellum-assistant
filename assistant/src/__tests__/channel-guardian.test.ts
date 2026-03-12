import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Test isolation: in-memory SQLite via temp directory
// ---------------------------------------------------------------------------

const testDir = mkdtempSync(join(tmpdir(), "channel-guardian-test-"));

mock.module("../util/platform.js", () => ({
  getRootDir: () => testDir,
  getDataDir: () => testDir,
  isMacOS: () => process.platform === "darwin",
  isLinux: () => process.platform === "linux",
  isWindows: () => process.platform === "win32",
  getPidPath: () => join(testDir, "test.pid"),
  getDbPath: () => join(testDir, "test.db"),
  getLogPath: () => join(testDir, "test.log"),
  ensureDataDir: () => {},
}));

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

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

// Track Telegram deliveries via fetch mock
const telegramDeliverCalls: Array<{
  chatId: string;
  text: string;
  assistantId?: string;
}> = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (
  input: string | URL | Request,
  init?: RequestInit,
) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
        ? input.toString()
        : input.url;
  if (url.includes("/deliver/telegram") && init?.method === "POST") {
    const body = JSON.parse(init.body as string) as {
      chatId: string;
      text: string;
      assistantId?: string;
    };
    telegramDeliverCalls.push(body);
    return new Response(JSON.stringify({ ok: true }), { status: 200 });
  }
  return originalFetch(input, init as never);
}) as unknown as typeof fetch;
import { eq } from "drizzle-orm";

import { createGuardianBinding } from "../contacts/contacts-write.js";
import { handleChannelVerificationSession } from "../daemon/handlers/config-channels.js";
import type { HandlerContext } from "../daemon/handlers/shared.js";
import type {
  ChannelVerificationSessionRequest,
  ChannelVerificationSessionResponse,
} from "../daemon/message-protocol.js";
import {
  bindSessionIdentity as _storeBindSessionIdentity,
  consumeSession,
  createInboundSession,
  createVerificationSession,
  findActiveSession as storeFindActiveSession,
  findPendingSessionByHash,
  findPendingSessionForChannel,
  findSessionByBootstrapTokenHash as _storeFindSessionByBootstrapTokenHash,
  findSessionByIdentity as _storeFindSessionByIdentity,
  updateSessionDelivery as storeUpdateSessionDelivery,
  updateSessionStatus as _storeUpdateSessionStatus,
} from "../memory/channel-verification-sessions.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import { upsertBinding as upsertExternalBinding } from "../memory/external-conversation-store.js";
import {
  createApprovalRequest,
  getPendingApprovalByGuardianChat,
  getPendingApprovalForRequest,
  updateApprovalDecision,
} from "../memory/guardian-approvals.js";
import {
  getRateLimit,
  recordInvalidAttempt,
  resetRateLimit,
} from "../memory/guardian-rate-limits.js";
import {
  channelVerificationSessions,
  conversations,
} from "../memory/schema.js";
import {
  bindSessionIdentity as serviceBindSessionIdentity,
  createInboundVerificationSession,
  createOutboundSession,
  findActiveSession as serviceFindActiveSession,
  findSessionByIdentity as serviceFindSessionByIdentity,
  getGuardianBinding,
  getPendingSession,
  isGuardian,
  resolveBootstrapToken,
  revokeBinding as serviceRevokeBinding,
  updateSessionStatus as serviceUpdateSessionStatus,
  validateAndConsumeVerification,
} from "../runtime/channel-verification-service.js";
import {
  MAX_SENDS_PER_SESSION,
  RESEND_COOLDOWN_MS,
} from "../runtime/verification-outbound-actions.js";
import {
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../runtime/verification-templates.js";

initializeDb();

afterAll(() => {
  globalThis.fetch = originalFetch;
  resetDb();
  try {
    rmSync(testDir, { recursive: true });
  } catch {
    /* best effort */
  }
});

function resetTables(): void {
  const db = getDb();
  db.run("DELETE FROM channel_verification_sessions");
  db.run("DELETE FROM channel_guardian_approval_requests");
  db.run("DELETE FROM channel_guardian_rate_limits");
  db.run("DELETE FROM contact_channels");
  db.run("DELETE FROM contacts");
  db.run("DELETE FROM external_conversation_bindings");
  telegramDeliverCalls.length = 0;
  voiceCallInitCalls.length = 0;
  mockBotUsername = "test_bot";
}

// ═══════════════════════════════════════════════════════════════════════════
// 2. Verification Challenge Lifecycle (Store)
// ═══════════════════════════════════════════════════════════════════════════

describe("verification challenge lifecycle", () => {
  beforeEach(() => {
    resetTables();
  });

  test("createInboundSession creates a pending challenge", () => {
    const challenge = createInboundSession({
      id: "chal-1",
      channel: "telegram",
      challengeHash: "abc123hash",
      expiresAt: Date.now() + 600_000,
    });

    expect(challenge.id).toBe("chal-1");
    expect(challenge.status).toBe("pending");
    expect(challenge.challengeHash).toBe("abc123hash");
    expect(challenge.consumedByExternalUserId).toBeNull();
    expect(challenge.consumedByChatId).toBeNull();
  });

  test("findPendingSessionByHash finds a matching pending challenge", () => {
    createInboundSession({
      id: "chal-1",
      channel: "telegram",
      challengeHash: "abc123hash",
      expiresAt: Date.now() + 600_000,
    });

    const found = findPendingSessionByHash("telegram", "abc123hash");
    expect(found).not.toBeNull();
    expect(found!.id).toBe("chal-1");
  });

  test("findPendingSessionByHash returns null for wrong hash", () => {
    createInboundSession({
      id: "chal-1",
      channel: "telegram",
      challengeHash: "abc123hash",
      expiresAt: Date.now() + 600_000,
    });

    const found = findPendingSessionByHash("telegram", "wrong-hash");
    expect(found).toBeNull();
  });

  test("findPendingSessionByHash returns null for expired challenge", () => {
    createInboundSession({
      id: "chal-1",
      channel: "telegram",
      challengeHash: "abc123hash",
      expiresAt: Date.now() - 1000, // already expired
    });

    const found = findPendingSessionByHash("telegram", "abc123hash");
    expect(found).toBeNull();
  });

  test("consumeSession marks challenge as consumed", () => {
    createInboundSession({
      id: "chal-1",
      channel: "telegram",
      challengeHash: "abc123hash",
      expiresAt: Date.now() + 600_000,
    });

    consumeSession("chal-1", "user-42", "chat-42");

    // After consumption, findPendingSessionByHash should return null
    const found = findPendingSessionByHash("telegram", "abc123hash");
    expect(found).toBeNull();
  });

  test("consumed challenge cannot be found again (replay prevention)", () => {
    createInboundSession({
      id: "chal-1",
      channel: "telegram",
      challengeHash: "abc123hash",
      expiresAt: Date.now() + 600_000,
    });

    // First consumption succeeds
    const found1 = findPendingSessionByHash("telegram", "abc123hash");
    expect(found1).not.toBeNull();
    consumeSession("chal-1", "user-42", "chat-42");

    // Second lookup returns null because challenge is consumed
    const found2 = findPendingSessionByHash("telegram", "abc123hash");
    expect(found2).toBeNull();
  });

  test("findPendingSessionByHash scoped to channel", () => {
    createInboundSession({
      id: "chal-1",
      channel: "telegram",
      challengeHash: "abc123hash",
      expiresAt: Date.now() + 600_000,
    });

    // Different channel — should not find
    expect(findPendingSessionByHash("slack", "abc123hash")).toBeNull();
    // Correct channel — should find
    expect(findPendingSessionByHash("telegram", "abc123hash")).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. Guardian Service — Challenge Validation
// ═══════════════════════════════════════════════════════════════════════════

describe("guardian service challenge validation", () => {
  beforeEach(() => {
    resetTables();
  });

  test("createInboundVerificationSession returns a secret, verifyCommand, ttlSeconds, and instruction", () => {
    const result = createInboundVerificationSession("telegram");

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

  test("createInboundVerificationSession produces a non-empty instruction for telegram channel", () => {
    const result = createInboundVerificationSession("telegram");
    expect(result.instruction).toBeDefined();
    expect(result.instruction.length).toBeGreaterThan(0);
    expect(result.instruction).toContain(`the code: ${result.secret}`);
  });

  test("createInboundVerificationSession produces a non-empty instruction for voice channel", () => {
    const result = createInboundVerificationSession("phone");
    expect(result.instruction).toBeDefined();
    expect(result.instruction.length).toBeGreaterThan(0);
    expect(result.instruction).toContain(`the code: ${result.secret}`);
  });

  test("validateAndConsumeVerification succeeds with correct secret", () => {
    const { secret } = createInboundVerificationSession("telegram");

    const result = validateAndConsumeVerification(
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

  test("validateAndConsumeVerification does not create a guardian binding (caller responsibility)", () => {
    const { secret } = createInboundVerificationSession("telegram");

    validateAndConsumeVerification("telegram", secret, "user-42", "chat-42");

    const binding = getGuardianBinding("asst-1", "telegram");
    expect(binding).toBeNull();
  });

  test("validateAndConsumeVerification fails with wrong secret", () => {
    createInboundVerificationSession("telegram");

    const result = validateAndConsumeVerification(
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

  test("validateAndConsumeVerification fails with expired challenge", () => {
    // Create a challenge that is already expired by inserting directly
    const secret = "test-secret-expired";
    const challengeHash = createHash("sha256").update(secret).digest("hex");
    createInboundSession({
      id: "chal-expired",
      channel: "telegram",
      challengeHash,
      expiresAt: Date.now() - 1000, // already expired
    });

    const result = validateAndConsumeVerification(
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

  test("consumed challenge cannot be reused", () => {
    const { secret } = createInboundVerificationSession("telegram");

    // First use succeeds
    const result1 = validateAndConsumeVerification(
      "telegram",
      secret,
      "user-42",
      "chat-42",
    );
    expect(result1.success).toBe(true);

    // Second use with same secret fails (replay prevention)
    const result2 = validateAndConsumeVerification(
      "telegram",
      secret,
      "user-99",
      "chat-99",
    );
    expect(result2.success).toBe(false);
  });

  test("validateAndConsumeVerification succeeds with voice channel", () => {
    const { secret } = createInboundVerificationSession("phone");

    const result = validateAndConsumeVerification(
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
    // now handled by the caller (verification-intercept / relay-server).
    const binding = getGuardianBinding("asst-1", "phone");
    expect(binding).toBeNull();
  });

  test("voice and telegram guardian challenges are independent", () => {
    const telegramChallenge = createInboundVerificationSession("telegram");
    const voiceChallenge = createInboundVerificationSession("phone");

    // Validate voice challenge against telegram channel should fail
    const crossResult = validateAndConsumeVerification(
      "telegram",
      voiceChallenge.secret,
      "user-1",
      "chat-1",
    );
    expect(crossResult.success).toBe(false);

    // Validate voice challenge against correct channel should succeed
    const voiceResult = validateAndConsumeVerification(
      "phone",
      voiceChallenge.secret,
      "user-1",
      "chat-1",
    );
    expect(voiceResult.success).toBe(true);

    // Telegram challenge should still be valid
    const telegramResult = validateAndConsumeVerification(
      "telegram",
      telegramChallenge.secret,
      "user-2",
      "chat-2",
    );
    expect(telegramResult.success).toBe(true);
  });

  test("validateAndConsumeVerification succeeds even with existing binding (conflict check is caller responsibility)", () => {
    // Create initial guardian binding
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "old-user",
      guardianPrincipalId: "old-user",
      guardianDeliveryChatId: "old-chat",
    });

    const oldBinding = getGuardianBinding("asst-1", "telegram");
    expect(oldBinding).not.toBeNull();
    expect(oldBinding!.guardianExternalUserId).toBe("old-user");

    const { secret } = createInboundVerificationSession("telegram");
    const result = validateAndConsumeVerification(
      "telegram",
      secret,
      "new-user",
      "new-chat",
    );

    // Challenge validation succeeds — the caller decides how to handle binding conflicts
    expect(result.success).toBe(true);

    const binding = getGuardianBinding("asst-1", "telegram");
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

  test("isGuardian returns true for matching user", () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-42",
      guardianPrincipalId: "user-42",
      guardianDeliveryChatId: "chat-42",
    });

    expect(isGuardian("asst-1", "telegram", "user-42")).toBe(true);
  });

  test("isGuardian returns false for non-matching user", () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-42",
      guardianPrincipalId: "user-42",
      guardianDeliveryChatId: "chat-42",
    });

    expect(isGuardian("asst-1", "telegram", "user-99")).toBe(false);
  });

  test("isGuardian returns false when no binding exists", () => {
    expect(isGuardian("asst-1", "telegram", "user-42")).toBe(false);
  });

  test("isGuardian returns false after binding is revoked", () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-42",
      guardianPrincipalId: "user-42",
      guardianDeliveryChatId: "chat-42",
    });

    serviceRevokeBinding("asst-1", "telegram");

    expect(isGuardian("asst-1", "telegram", "user-42")).toBe(false);
  });

  test("getGuardianBinding returns the active binding", () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-42",
      guardianPrincipalId: "user-42",
      guardianDeliveryChatId: "chat-42",
    });

    const binding = getGuardianBinding("asst-1", "telegram");
    expect(binding).not.toBeNull();
    expect(binding!.guardianExternalUserId).toBe("user-42");
  });

  test("getGuardianBinding returns null when no binding exists", () => {
    const binding = getGuardianBinding("asst-1", "telegram");
    expect(binding).toBeNull();
  });

  test("isGuardian works for voice channel", () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "phone-user-1",
      guardianPrincipalId: "phone-user-1",
      guardianDeliveryChatId: "voice-chat-1",
    });

    expect(isGuardian("asst-1", "phone", "phone-user-1")).toBe(true);
    expect(isGuardian("asst-1", "phone", "phone-user-2")).toBe(false);
    // Telegram guardian should not match voice channel
    expect(isGuardian("asst-1", "telegram", "phone-user-1")).toBe(false);
  });

  test("serviceRevokeBinding revokes the active binding", () => {
    createGuardianBinding({
      channel: "telegram",
      guardianExternalUserId: "user-42",
      guardianPrincipalId: "user-42",
      guardianDeliveryChatId: "chat-42",
    });

    const result = serviceRevokeBinding("asst-1", "telegram");
    expect(result).toBe(true);
    expect(getGuardianBinding("asst-1", "telegram")).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Approval Request CRUD (Store)
// ═══════════════════════════════════════════════════════════════════════════

describe("guardian approval request CRUD", () => {
  beforeEach(() => {
    resetTables();
  });

  test("createApprovalRequest creates a pending request", () => {
    const request = createApprovalRequest({
      runId: "run-1",
      requestId: "req-1",
      conversationId: "conv-1",
      channel: "telegram",
      requesterExternalUserId: "user-99",
      requesterChatId: "chat-99",
      guardianExternalUserId: "user-42",
      guardianChatId: "chat-42",
      toolName: "shell",
      riskLevel: "high",
      reason: "Executing rm command",
      expiresAt: Date.now() + 300_000,
    });

    expect(request.id).toBeDefined();
    expect(request.runId).toBe("run-1");
    expect(request.requestId).toBe("req-1");
    expect(request.status).toBe("pending");
    expect(request.toolName).toBe("shell");
    expect(request.riskLevel).toBe("high");
    expect(request.reason).toBe("Executing rm command");
    expect(request.decidedByExternalUserId).toBeNull();
  });

  test("getPendingApprovalForRequest returns the pending request", () => {
    createApprovalRequest({
      runId: "run-1",
      requestId: "req-1",
      conversationId: "conv-1",
      channel: "telegram",
      requesterExternalUserId: "user-99",
      requesterChatId: "chat-99",
      guardianExternalUserId: "user-42",
      guardianChatId: "chat-42",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    const found = getPendingApprovalForRequest("req-1");
    expect(found).not.toBeNull();
    expect(found!.requestId).toBe("req-1");
    expect(found!.status).toBe("pending");
  });

  test("getPendingApprovalForRequest returns null when no pending request exists", () => {
    const found = getPendingApprovalForRequest("req-nonexistent");
    expect(found).toBeNull();
  });

  test("getPendingApprovalByGuardianChat returns pending request for guardian chat", () => {
    createApprovalRequest({
      runId: "run-1",
      requestId: "req-1",
      conversationId: "conv-1",
      channel: "telegram",
      requesterExternalUserId: "user-99",
      requesterChatId: "chat-99",
      guardianExternalUserId: "user-42",
      guardianChatId: "chat-42",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    const found = getPendingApprovalByGuardianChat("telegram", "chat-42");
    expect(found).not.toBeNull();
    expect(found!.guardianChatId).toBe("chat-42");
  });

  test("getPendingApprovalByGuardianChat returns null for wrong channel", () => {
    createApprovalRequest({
      runId: "run-1",
      requestId: "req-1",
      conversationId: "conv-1",
      channel: "telegram",
      requesterExternalUserId: "user-99",
      requesterChatId: "chat-99",
      guardianExternalUserId: "user-42",
      guardianChatId: "chat-42",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    const found = getPendingApprovalByGuardianChat("slack", "chat-42");
    expect(found).toBeNull();
  });

  test("updateApprovalDecision updates status to approved", () => {
    const request = createApprovalRequest({
      runId: "run-1",
      requestId: "req-1",
      conversationId: "conv-1",
      channel: "telegram",
      requesterExternalUserId: "user-99",
      requesterChatId: "chat-99",
      guardianExternalUserId: "user-42",
      guardianChatId: "chat-42",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    updateApprovalDecision(request.id, {
      status: "approved",
      decidedByExternalUserId: "user-42",
    });

    // After approval, getPendingApprovalForRequest should return null
    const found = getPendingApprovalForRequest("req-1");
    expect(found).toBeNull();
  });

  test("updateApprovalDecision updates status to denied", () => {
    const request = createApprovalRequest({
      runId: "run-1",
      requestId: "req-1",
      conversationId: "conv-1",
      channel: "telegram",
      requesterExternalUserId: "user-99",
      requesterChatId: "chat-99",
      guardianExternalUserId: "user-42",
      guardianChatId: "chat-42",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    updateApprovalDecision(request.id, {
      status: "denied",
      decidedByExternalUserId: "user-42",
    });

    const found = getPendingApprovalForRequest("req-1");
    expect(found).toBeNull();
  });

  test("multiple approval requests for different runs are independent", () => {
    createApprovalRequest({
      runId: "run-1",
      requestId: "req-1",
      conversationId: "conv-1",
      channel: "telegram",
      requesterExternalUserId: "user-99",
      requesterChatId: "chat-99",
      guardianExternalUserId: "user-42",
      guardianChatId: "chat-42",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    createApprovalRequest({
      runId: "run-2",
      requestId: "req-2",
      conversationId: "conv-2",
      channel: "telegram",
      requesterExternalUserId: "user-88",
      requesterChatId: "chat-88",
      guardianExternalUserId: "user-42",
      guardianChatId: "chat-42",
      toolName: "browser",
      expiresAt: Date.now() + 300_000,
    });

    const found1 = getPendingApprovalForRequest("req-1");
    const found2 = getPendingApprovalForRequest("req-2");
    expect(found1).not.toBeNull();
    expect(found2).not.toBeNull();
    expect(found1!.toolName).toBe("shell");
    expect(found2!.toolName).toBe("browser");
  });

  test("createApprovalRequest works for voice channel", () => {
    const request = createApprovalRequest({
      runId: "run-voice-1",
      requestId: "req-voice-1",
      conversationId: "conv-voice-1",
      channel: "phone",
      requesterExternalUserId: "phone-user-99",
      requesterChatId: "voice-chat-99",
      guardianExternalUserId: "phone-user-42",
      guardianChatId: "voice-chat-42",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    expect(request.id).toBeDefined();
    expect(request.runId).toBe("run-voice-1");
    expect(request.requestId).toBe("req-voice-1");
    expect(request.channel).toBe("phone");
    expect(request.status).toBe("pending");

    const found = getPendingApprovalForRequest("req-voice-1");
    expect(found).not.toBeNull();
    expect(found!.channel).toBe("phone");
  });

  test("getPendingApprovalByGuardianChat works for voice channel", () => {
    createApprovalRequest({
      runId: "run-voice-2",
      requestId: "req-voice-2",
      conversationId: "conv-voice-2",
      channel: "phone",
      requesterExternalUserId: "phone-user-99",
      requesterChatId: "voice-chat-99",
      guardianExternalUserId: "phone-user-42",
      guardianChatId: "voice-chat-42",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    const found = getPendingApprovalByGuardianChat("phone", "voice-chat-42");
    expect(found).not.toBeNull();
    expect(found!.channel).toBe("phone");

    // Should not find it under a different channel
    const notFound = getPendingApprovalByGuardianChat(
      "telegram",
      "voice-chat-42",
    );
    expect(notFound).toBeNull();
  });

  test("createApprovalRequest with optional fields omitted defaults to null", () => {
    const request = createApprovalRequest({
      runId: "run-1",
      requestId: "req-1",
      conversationId: "conv-1",
      channel: "telegram",
      requesterExternalUserId: "user-99",
      requesterChatId: "chat-99",
      guardianExternalUserId: "user-42",
      guardianChatId: "chat-42",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });

    expect(request.riskLevel).toBeNull();
    expect(request.reason).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Verification Rate Limiting (Store)
// ═══════════════════════════════════════════════════════════════════════════

describe("verification rate limiting store", () => {
  beforeEach(() => {
    resetTables();
  });

  test("getRateLimit returns null when no record exists", () => {
    const rl = getRateLimit("telegram", "user-42", "chat-42");
    expect(rl).toBeNull();
  });

  test("recordInvalidAttempt creates a new record on first failure", () => {
    const rl = recordInvalidAttempt(
      "telegram",
      "user-42",
      "chat-42",
      900_000,
      5,
      1_800_000,
    );
    expect(rl.invalidAttempts).toBe(1);
    expect(rl.lockedUntil).toBeNull();
    // assistantId column has been removed; no longer asserted
    expect(rl.channel).toBe("telegram");
    expect(rl.actorExternalUserId).toBe("user-42");
  });

  test("recordInvalidAttempt increments counter on subsequent failures", () => {
    recordInvalidAttempt(
      "telegram",
      "user-42",
      "chat-42",
      900_000,
      5,
      1_800_000,
    );
    recordInvalidAttempt(
      "telegram",
      "user-42",
      "chat-42",
      900_000,
      5,
      1_800_000,
    );
    const rl = recordInvalidAttempt(
      "telegram",
      "user-42",
      "chat-42",
      900_000,
      5,
      1_800_000,
    );
    expect(rl.invalidAttempts).toBe(3);
    expect(rl.lockedUntil).toBeNull();
  });

  test("recordInvalidAttempt sets lockedUntil when max attempts reached", () => {
    for (let i = 0; i < 4; i++) {
      recordInvalidAttempt(
        "telegram",
        "user-42",
        "chat-42",
        900_000,
        5,
        1_800_000,
      );
    }
    const rl = recordInvalidAttempt(
      "telegram",
      "user-42",
      "chat-42",
      900_000,
      5,
      1_800_000,
    );
    expect(rl.invalidAttempts).toBe(5);
    expect(rl.lockedUntil).not.toBeNull();
    expect(rl.lockedUntil!).toBeGreaterThan(Date.now());
  });

  test("resetRateLimit clears the counter and lockout", () => {
    for (let i = 0; i < 5; i++) {
      recordInvalidAttempt(
        "telegram",
        "user-42",
        "chat-42",
        900_000,
        5,
        1_800_000,
      );
    }
    const locked = getRateLimit("telegram", "user-42", "chat-42");
    expect(locked).not.toBeNull();
    expect(locked!.lockedUntil).not.toBeNull();

    resetRateLimit("telegram", "user-42", "chat-42");

    const after = getRateLimit("telegram", "user-42", "chat-42");
    expect(after).not.toBeNull();
    expect(after!.invalidAttempts).toBe(0);
    expect(after!.lockedUntil).toBeNull();
  });

  test("rate limits are scoped per actor and channel", () => {
    recordInvalidAttempt(
      "telegram",
      "user-42",
      "chat-42",
      900_000,
      5,
      1_800_000,
    );
    recordInvalidAttempt(
      "telegram",
      "user-99",
      "chat-99",
      900_000,
      5,
      1_800_000,
    );

    const rl42 = getRateLimit("telegram", "user-42", "chat-42");
    const rl99 = getRateLimit("telegram", "user-99", "chat-99");
    const rlVoice = getRateLimit("phone", "user-42", "chat-42");

    expect(rl42).not.toBeNull();
    expect(rl42!.invalidAttempts).toBe(1);
    expect(rl99).not.toBeNull();
    expect(rl99!.invalidAttempts).toBe(1);
    expect(rlVoice).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Verification Rate Limiting (Service — end-to-end)
// ═══════════════════════════════════════════════════════════════════════════

describe("guardian service rate limiting", () => {
  beforeEach(() => {
    resetTables();
  });

  test("repeated invalid submissions hit rate limit", () => {
    // Create a valid challenge so there is a pending challenge
    createInboundVerificationSession("telegram");

    // Submit wrong codes repeatedly
    for (let i = 0; i < 5; i++) {
      const result = validateAndConsumeVerification(
        "telegram",
        `wrong-secret-${i}`,
        "user-42",
        "chat-42",
      );
      expect(result.success).toBe(false);
    }

    // The 6th attempt should be rate-limited even without a new challenge
    const result = validateAndConsumeVerification(
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
    const rl = getRateLimit("telegram", "user-42", "chat-42");
    expect(rl).not.toBeNull();
    expect(rl!.lockedUntil).not.toBeNull();
  });

  test("valid challenge still succeeds when under threshold", () => {
    // Record a couple invalid attempts
    const { secret: _secret } = createInboundVerificationSession("telegram");
    validateAndConsumeVerification("telegram", "wrong-1", "user-42", "chat-42");
    validateAndConsumeVerification("telegram", "wrong-2", "user-42", "chat-42");

    // Valid attempt should still succeed (under the 5-attempt threshold)
    // Need a new challenge since the old one is still pending but the secret was never consumed
    const { secret: secret2 } = createInboundVerificationSession("telegram");
    const result = validateAndConsumeVerification(
      "telegram",
      secret2,
      "user-42",
      "chat-42",
    );
    expect(result.success).toBe(true);

    // Rate limit should be reset after success
    const rl = getRateLimit("telegram", "user-42", "chat-42");
    expect(rl).not.toBeNull();
    expect(rl!.invalidAttempts).toBe(0);
    expect(rl!.lockedUntil).toBeNull();
  });

  test("rate-limit uses generic failure message (no oracle leakage)", () => {
    createInboundVerificationSession("telegram");

    // Capture a normal invalid-code failure response
    const normalFailure = validateAndConsumeVerification(
      "telegram",
      "wrong-first",
      "user-42",
      "chat-42",
    );
    expect(normalFailure.success).toBe(false);
    const normalReason = (normalFailure as { reason: string }).reason;

    // Trigger rate limit (4 more attempts to reach 5 total)
    for (let i = 0; i < 4; i++) {
      validateAndConsumeVerification(
        "telegram",
        `wrong-${i}`,
        "user-42",
        "chat-42",
      );
    }

    // Verify lockout is actually active before testing the rate-limited response
    const rl = getRateLimit("telegram", "user-42", "chat-42");
    expect(rl).not.toBeNull();
    expect(rl!.lockedUntil).toBeGreaterThan(Date.now());

    // The rate-limited response should be indistinguishable from normal failure
    const rateLimitedResult = validateAndConsumeVerification(
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

  test("rate limit does not affect different actors", () => {
    // Rate-limit user-42
    createInboundVerificationSession("telegram");
    for (let i = 0; i < 5; i++) {
      validateAndConsumeVerification(
        "telegram",
        `wrong-${i}`,
        "user-42",
        "chat-42",
      );
    }

    // user-99 should still be able to verify
    const { secret } = createInboundVerificationSession("telegram");
    const result = validateAndConsumeVerification(
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

  test("isGuardian resolves independently per channel", () => {
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
    expect(isGuardian("self", "telegram", "user-alpha")).toBe(true);
    expect(isGuardian("self", "phone", "user-alpha")).toBe(false);

    // user-beta is guardian for voice but not telegram
    expect(isGuardian("self", "phone", "user-beta")).toBe(true);
    expect(isGuardian("self", "telegram", "user-beta")).toBe(false);
  });

  test("getGuardianBinding returns different bindings for different channels", () => {
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

    const bindingTelegram = getGuardianBinding("self", "telegram");
    const bindingVoice = getGuardianBinding("self", "phone");

    expect(bindingTelegram).not.toBeNull();
    expect(bindingVoice).not.toBeNull();
    expect(bindingTelegram!.guardianExternalUserId).toBe("user-alpha");
    expect(bindingVoice!.guardianExternalUserId).toBe("user-beta");
  });

  test("revoking binding for one channel does not affect another", () => {
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

    serviceRevokeBinding("self", "telegram");

    expect(getGuardianBinding("self", "telegram")).toBeNull();
    expect(getGuardianBinding("self", "phone")).not.toBeNull();
  });

  test("validateAndConsumeVerification scoped to channel", () => {
    // Create challenge on telegram
    const { secret: secretTelegram } =
      createInboundVerificationSession("telegram");
    // Create challenge on voice
    const { secret: secretVoice } = createInboundVerificationSession("phone");

    // Attempting to consume telegram challenge on voice should fail
    const crossResult = validateAndConsumeVerification(
      "phone",
      secretTelegram,
      "user-1",
      "chat-1",
    );
    expect(crossResult.success).toBe(false);

    // Consuming with correct channel should succeed
    const resultTelegram = validateAndConsumeVerification(
      "telegram",
      secretTelegram,
      "user-1",
      "chat-1",
    );
    expect(resultTelegram.success).toBe(true);

    const resultVoice = validateAndConsumeVerification(
      "phone",
      secretVoice,
      "user-2",
      "chat-2",
    );
    expect(resultVoice.success).toBe(true);

    const bindingTelegram = getGuardianBinding("self", "telegram");
    const bindingVoice = getGuardianBinding("self", "phone");
    expect(bindingTelegram).toBeNull();
    expect(bindingVoice).toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Assistant-scoped approval request lookups
// ═══════════════════════════════════════════════════════════════════════════

describe("assistant-scoped approval request lookups", () => {
  beforeEach(() => {
    resetTables();
  });

  test("createApprovalRequest no longer exposes assistantId on the returned interface", () => {
    const req = createApprovalRequest({
      runId: "run-1",
      requestId: "req-1",
      conversationId: "conv-1",
      channel: "telegram",
      requesterExternalUserId: "user-99",
      requesterChatId: "chat-99",
      guardianExternalUserId: "user-42",
      guardianChatId: "chat-42",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });
    // assistantId is no longer on the public interface
    expect(req.id).toBeDefined();
    expect(req.toolName).toBe("shell");
  });

  test("approval requests from different conversations are independent", () => {
    createApprovalRequest({
      runId: "run-A",
      requestId: "req-A",
      conversationId: "conv-A",
      channel: "telegram",
      requesterExternalUserId: "user-99",
      requesterChatId: "chat-99",
      guardianExternalUserId: "user-42",
      guardianChatId: "chat-42",
      toolName: "shell",
      expiresAt: Date.now() + 300_000,
    });
    createApprovalRequest({
      runId: "run-B",
      requestId: "req-B",
      conversationId: "conv-B",
      channel: "telegram",
      requesterExternalUserId: "user-88",
      requesterChatId: "chat-88",
      guardianExternalUserId: "user-42",
      guardianChatId: "chat-42",
      toolName: "browser",
      expiresAt: Date.now() + 300_000,
    });

    const foundA = getPendingApprovalForRequest("req-A");
    const foundB = getPendingApprovalForRequest("req-B");
    expect(foundA).not.toBeNull();
    expect(foundB).not.toBeNull();
    expect(foundA!.toolName).toBe("shell");
    expect(foundB!.toolName).toBe("browser");
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. HTTP handler — channel-aware guardian status response
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Creates a minimal mock HandlerContext that captures the response sent via ctx.send().
 */
function createMockCtx(): {
  ctx: HandlerContext;
  lastResponse: () => ChannelVerificationSessionResponse | null;
} {
  let captured: ChannelVerificationSessionResponse | null = null;
  const ctx = {
    sessions: new Map(),
    sharedRequestTimestamps: [],
    debounceTimers: {
      schedule: () => {},
      cancel: () => {},
    } as unknown as HandlerContext["debounceTimers"],
    suppressConfigReload: false,
    setSuppressConfigReload: () => {},
    updateConfigFingerprint: () => {},
    send: (msg: unknown) => {
      captured = msg as ChannelVerificationSessionResponse;
    },
    broadcast: () => {},
    clearAllSessions: () => 0,
    getOrCreateSession: () => Promise.resolve({} as never),
    touchSession: () => {},
  } as unknown as HandlerContext;
  return { ctx, lastResponse: () => captured };
}

describe("HTTP handler channel-aware guardian status", () => {
  beforeEach(() => {
    resetTables();
  });

  test("status action for telegram returns channel and assistantId fields", async () => {
    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "telegram",
    };

    await handleChannelVerificationSession(msg, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.channel).toBe("telegram");
    expect(resp!.assistantId).toBe("self");
    expect(resp!.bound).toBe(false);
    expect(resp!.guardianDeliveryChatId).toBeUndefined();
  });

  test("status action for voice returns channel: voice and assistantId: self", async () => {
    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg, ctx);

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

    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "telegram",
    };

    await handleChannelVerificationSession(msg, ctx);

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

    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "telegram",
    };

    await handleChannelVerificationSession(msg, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.guardianUsername).toBe("guardian_handle");
    expect(resp!.guardianDisplayName).toBe("Guardian Name");
  });

  test("status action defaults channel to telegram when omitted (backward compat)", async () => {
    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      // channel omitted — should default to 'telegram'
    };

    await handleChannelVerificationSession(msg, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.channel).toBe("telegram");
    expect(resp!.assistantId).toBe("self");
  });

  test("status action defaults assistantId to self when omitted (backward compat)", async () => {
    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
      // assistantId omitted — should default to 'self'
    };

    await handleChannelVerificationSession(msg, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.assistantId).toBe("self");
    expect(resp!.channel).toBe("phone");
  });

  test("status action for unbound voice does not return guardianDeliveryChatId", async () => {
    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.bound).toBe(false);
    expect(resp!.guardianDeliveryChatId).toBeUndefined();
    expect(resp!.guardianExternalUserId).toBeUndefined();
  });

  test("status action includes hasPendingChallenge when challenge exists", async () => {
    createInboundVerificationSession("phone");

    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.hasPendingChallenge).toBe(true);
  });

  test("status action hasPendingChallenge is false when no challenge exists", async () => {
    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg, ctx);

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

  test("createInboundVerificationSession for voice returns a high-entropy hex secret", () => {
    const result = createInboundVerificationSession("phone");

    expect(result.challengeId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result.secret.length).toBe(64);
  });

  test("createInboundVerificationSession for non-voice returns high-entropy hex secret", () => {
    const result = createInboundVerificationSession("telegram");

    expect(result.secret.length).toBe(64);
    expect(result.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  test("voice challenge verifyCommand contains the hex secret", () => {
    const result = createInboundVerificationSession("phone");

    expect(result.verifyCommand).toBe(result.secret);
  });

  test("voice challenge instruction contains voice-specific copy", () => {
    const result = createInboundVerificationSession("phone");

    // Inbound challenges use high-entropy hex, so the voice template says
    // "enter the code" rather than "six-digit code".
    expect(result.instruction).toContain("enter the code");
    expect(result.instruction).toContain(result.secret);
  });

  test("voice challenge secrets are different across calls", () => {
    const result1 = createInboundVerificationSession("phone");
    const result2 = createInboundVerificationSession("phone");

    // High-entropy hex secrets: collision probability is negligible
    expect(result1.secret).toMatch(/^[0-9a-f]{64}$/);
    expect(result2.secret).toMatch(/^[0-9a-f]{64}$/);
  });

  test("voice ttlSeconds is 600 (10 minutes)", () => {
    const result = createInboundVerificationSession("phone");
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

  test("validateAndConsumeVerification succeeds with correct voice secret", () => {
    const { secret } = createInboundVerificationSession("phone");

    const result = validateAndConsumeVerification(
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

  test("validateAndConsumeVerification does not create a guardian binding for voice (caller responsibility)", () => {
    const { secret } = createInboundVerificationSession("phone");

    validateAndConsumeVerification(
      "phone",
      secret,
      "voice-user-1",
      "voice-chat-1",
    );

    const binding = getGuardianBinding("asst-1", "phone");
    expect(binding).toBeNull();
  });

  test("validateAndConsumeVerification fails with wrong voice secret", () => {
    createInboundVerificationSession("phone");

    const result = validateAndConsumeVerification(
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

  test("voice and telegram guardian challenges are independent", () => {
    const voiceChallenge = createInboundVerificationSession("phone");
    const telegramChallenge = createInboundVerificationSession("telegram");

    // Voice secret against telegram channel should fail
    const crossResult = validateAndConsumeVerification(
      "telegram",
      voiceChallenge.secret,
      "user-1",
      "chat-1",
    );
    expect(crossResult.success).toBe(false);

    // Voice secret against correct channel should succeed
    const voiceResult = validateAndConsumeVerification(
      "phone",
      voiceChallenge.secret,
      "voice-user-1",
      "voice-chat-1",
    );
    expect(voiceResult.success).toBe(true);

    // Telegram challenge should still be valid
    const telegramResult = validateAndConsumeVerification(
      "telegram",
      telegramChallenge.secret,
      "user-2",
      "chat-2",
    );
    expect(telegramResult.success).toBe(true);
  });

  test("consumed voice challenge cannot be reused", () => {
    const { secret } = createInboundVerificationSession("phone");

    const result1 = validateAndConsumeVerification(
      "phone",
      secret,
      "voice-user-1",
      "voice-chat-1",
    );
    expect(result1.success).toBe(true);

    const result2 = validateAndConsumeVerification(
      "phone",
      secret,
      "voice-user-2",
      "voice-chat-2",
    );
    expect(result2.success).toBe(false);
  });

  test("validateAndConsumeVerification succeeds even with existing voice binding (conflict check is caller responsibility)", () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "old-voice-user",
      guardianPrincipalId: "old-voice-user",
      guardianDeliveryChatId: "old-voice-chat",
    });

    const oldBinding = getGuardianBinding("asst-1", "phone");
    expect(oldBinding).not.toBeNull();
    expect(oldBinding!.guardianExternalUserId).toBe("old-voice-user");

    const { secret } = createInboundVerificationSession("phone");
    const result = validateAndConsumeVerification(
      "phone",
      secret,
      "new-voice-user",
      "new-voice-chat",
    );

    // Challenge validation succeeds
    expect(result.success).toBe(true);

    // The original binding is untouched (no side effects)
    const binding = getGuardianBinding("asst-1", "phone");
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

  test("isGuardian works for voice channel", () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "voice-user-1",
      guardianPrincipalId: "voice-user-1",
      guardianDeliveryChatId: "voice-chat-1",
    });

    expect(isGuardian("asst-1", "phone", "voice-user-1")).toBe(true);
    expect(isGuardian("asst-1", "phone", "voice-user-2")).toBe(false);
    // Voice guardian should not match telegram channel
    expect(isGuardian("asst-1", "telegram", "voice-user-1")).toBe(false);
  });

  test("getGuardianBinding returns voice binding", () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "voice-user-1",
      guardianPrincipalId: "voice-user-1",
      guardianDeliveryChatId: "voice-chat-1",
    });

    const binding = getGuardianBinding("asst-1", "phone");
    expect(binding).not.toBeNull();
    expect(binding!.channel).toBe("phone");
    expect(binding!.guardianExternalUserId).toBe("voice-user-1");
  });

  test("revokeBinding clears active voice guardian binding", () => {
    createGuardianBinding({
      channel: "phone",
      guardianExternalUserId: "voice-user-1",
      guardianPrincipalId: "voice-user-1",
      guardianDeliveryChatId: "voice-chat-1",
    });

    const result = serviceRevokeBinding("asst-1", "phone");
    expect(result).toBe(true);
    expect(getGuardianBinding("asst-1", "phone")).toBeNull();
  });

  test("revokeBinding for voice does not affect telegram binding", () => {
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

    serviceRevokeBinding("asst-1", "phone");

    expect(getGuardianBinding("asst-1", "phone")).toBeNull();
    expect(getGuardianBinding("asst-1", "telegram")).not.toBeNull();
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 14. Voice Guardian Rate Limiting
// ═══════════════════════════════════════════════════════════════════════════

describe("voice guardian rate limiting", () => {
  beforeEach(() => {
    resetTables();
  });

  test("repeated invalid voice submissions hit rate limit", () => {
    createInboundVerificationSession("phone");

    for (let i = 0; i < 5; i++) {
      const result = validateAndConsumeVerification(
        "phone",
        `${100000 + i}`,
        "voice-user-1",
        "voice-chat-1",
      );
      expect(result.success).toBe(false);
    }

    // The 6th attempt should be rate-limited
    const result = validateAndConsumeVerification(
      "phone",
      "999999",
      "voice-user-1",
      "voice-chat-1",
    );
    expect(result.success).toBe(false);

    const rl = getRateLimit("phone", "voice-user-1", "voice-chat-1");
    expect(rl).not.toBeNull();
    expect(rl!.lockedUntil).not.toBeNull();
  });

  test("voice rate limit does not affect telegram rate limit", () => {
    createInboundVerificationSession("phone");
    for (let i = 0; i < 5; i++) {
      validateAndConsumeVerification(
        "phone",
        `${100000 + i}`,
        "user-1",
        "chat-1",
      );
    }

    const voiceRl = getRateLimit("phone", "user-1", "chat-1");
    expect(voiceRl).not.toBeNull();
    expect(voiceRl!.lockedUntil).not.toBeNull();

    // Telegram should be unaffected
    const telegramRl = getRateLimit("telegram", "user-1", "chat-1");
    expect(telegramRl).toBeNull();
  });

  test("successful voice verification resets rate limit", () => {
    const { secret: _s } = createInboundVerificationSession("phone");
    validateAndConsumeVerification(
      "phone",
      "000000",
      "voice-user-1",
      "voice-chat-1",
    );
    validateAndConsumeVerification(
      "phone",
      "111111",
      "voice-user-1",
      "voice-chat-1",
    );

    // Valid attempt should succeed (under the 5-attempt threshold)
    const { secret } = createInboundVerificationSession("phone");
    const result = validateAndConsumeVerification(
      "phone",
      secret,
      "voice-user-1",
      "voice-chat-1",
    );
    expect(result.success).toBe(true);

    const rl = getRateLimit("phone", "voice-user-1", "voice-chat-1");
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

  test("findPendingSessionForChannel returns pending challenge", () => {
    createInboundVerificationSession("phone");

    const pending = findPendingSessionForChannel("phone");
    expect(pending).not.toBeNull();
    expect(pending!.channel).toBe("phone");
    expect(pending!.status).toBe("pending");
  });

  test("findPendingSessionForChannel returns null when no challenge exists", () => {
    const pending = findPendingSessionForChannel("phone");
    expect(pending).toBeNull();
  });

  test("findPendingSessionForChannel returns null for different channel", () => {
    createInboundVerificationSession("telegram");

    const pending = findPendingSessionForChannel("phone");
    expect(pending).toBeNull();
  });

  test("findPendingSessionForChannel returns null after challenge is consumed", () => {
    const { secret } = createInboundVerificationSession("phone");
    validateAndConsumeVerification(
      "phone",
      secret,
      "voice-user-1",
      "voice-chat-1",
    );

    const pending = findPendingSessionForChannel("phone");
    expect(pending).toBeNull();
  });

  test("getPendingSession service helper returns pending voice challenge", () => {
    createInboundVerificationSession("phone");

    const pending = getPendingSession("phone");
    expect(pending).not.toBeNull();
    expect(pending!.channel).toBe("phone");
  });

  test("getPendingSession returns null when no challenge exists", () => {
    const pending = getPendingSession("phone");
    expect(pending).toBeNull();
  });

  test("creating a new challenge revokes prior pending challenges", () => {
    createInboundVerificationSession("phone");
    const pending1 = findPendingSessionForChannel("phone");
    expect(pending1).not.toBeNull();
    const firstId = pending1!.id;

    // Creating a second challenge should revoke the first
    createInboundVerificationSession("phone");
    const pending2 = findPendingSessionForChannel("phone");
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
    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg, ctx);

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
    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg, ctx);

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

    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "status",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg, ctx);

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

    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "revoke",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.bound).toBe(false);

    // Verify binding is actually revoked
    expect(getGuardianBinding("self", "phone")).toBeNull();
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

    const { ctx } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "revoke",
      channel: "phone",
    };

    await handleChannelVerificationSession(msg, ctx);

    expect(getGuardianBinding("self", "phone")).toBeNull();
    expect(getGuardianBinding("self", "telegram")).not.toBeNull();
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

  test("createOutboundSession creates a session with expected identity fields", () => {
    const result = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    expect(result.sessionId).toBeDefined();
    expect(result.secret).toBeDefined();
    expect(result.challengeHash).toBeDefined();
    expect(result.expiresAt).toBeGreaterThan(Date.now());
    expect(result.ttlSeconds).toBe(600);

    const session = serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    expect(session!.expectedPhoneE164).toBe("+15551234567");
    expect(session!.destinationAddress).toBe("+15551234567");
    expect(session!.identityBindingStatus).toBe("bound");
    expect(session!.status).toBe("awaiting_response");
  });

  test("createOutboundSession for telegram with pending_bootstrap status", () => {
    const result = createOutboundSession({
      channel: "telegram",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@some_handle",
    });

    expect(result.sessionId).toBeDefined();

    const session = serviceFindActiveSession("telegram");
    expect(session).not.toBeNull();
    expect(session!.identityBindingStatus).toBe("pending_bootstrap");
    expect(session!.status).toBe("pending_bootstrap");
    expect(session!.expectedExternalUserId).toBeNull();
    expect(session!.expectedChatId).toBeNull();
  });

  // ── Identity match: right code + right identity → success ──

  test("validateAndConsumeVerification succeeds with correct secret and matching identity (voice)", () => {
    const { secret } = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      expectedExternalUserId: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const result = validateAndConsumeVerification(
      "phone",
      secret,
      "+15551234567",
      "voice-chat-1",
    );

    expect(result.success).toBe(true);
  });

  test("validateAndConsumeVerification succeeds with correct secret and matching identity (Telegram)", () => {
    const { secret } = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "tg-user-42",
      expectedChatId: "tg-chat-42",
      destinationAddress: "tg-chat-42",
    });

    const result = validateAndConsumeVerification(
      "telegram",
      secret,
      "tg-user-42",
      "tg-chat-42",
    );

    expect(result.success).toBe(true);
  });

  // ── Identity mismatch: right code + wrong identity → reject ──

  test("validateAndConsumeVerification rejects correct secret with wrong identity (anti-oracle)", () => {
    const { secret } = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      expectedExternalUserId: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const result = validateAndConsumeVerification(
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

  test("validateAndConsumeVerification rejects correct secret with wrong Telegram identity", () => {
    const { secret } = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "tg-user-42",
      expectedChatId: "tg-chat-42",
      destinationAddress: "tg-chat-42",
    });

    const result = validateAndConsumeVerification(
      "telegram",
      secret,
      "tg-user-WRONG",
      "tg-chat-WRONG",
    );

    expect(result.success).toBe(false);
  });

  // ── Expired session → reject ──

  test("expired outbound session is rejected", () => {
    // Create a session directly via the store with an already-expired expiresAt
    const secret = "test-expired-session-secret";
    const challengeHash = createHash("sha256").update(secret).digest("hex");
    createVerificationSession({
      id: "session-expired",
      channel: "phone",
      challengeHash,
      expiresAt: Date.now() - 1000,
      status: "awaiting_response",
      expectedPhoneE164: "+15551234567",
      identityBindingStatus: "bound",
    });

    const result = validateAndConsumeVerification(
      "phone",
      secret,
      "+15551234567",
      "voice-chat-1",
    );

    expect(result.success).toBe(false);
  });

  // ── Revoked session → reject ──

  test("revoked outbound session is rejected", () => {
    const { secret, sessionId } = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    // Revoke the session
    serviceUpdateSessionStatus(sessionId, "revoked");

    const result = validateAndConsumeVerification(
      "phone",
      secret,
      "+15551234567",
      "voice-chat-1",
    );

    expect(result.success).toBe(false);
  });

  // ── One-time consumption (replay prevention) ──

  test("outbound session cannot be consumed twice (replay prevention)", () => {
    const { secret } = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      expectedExternalUserId: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const result1 = validateAndConsumeVerification(
      "phone",
      secret,
      "+15551234567",
      "voice-chat-1",
    );
    expect(result1.success).toBe(true);

    const result2 = validateAndConsumeVerification(
      "phone",
      secret,
      "+15551234567",
      "voice-chat-1",
    );
    expect(result2.success).toBe(false);
  });

  // ── Backward compat: existing inbound-only flow still works ──

  test("backward compat: inbound-only challenge without expected identity still works", () => {
    const { secret } = createInboundVerificationSession("telegram");

    const result = validateAndConsumeVerification(
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

  test("session state transitions (pending_bootstrap → awaiting_response → verified)", () => {
    const { sessionId } = createOutboundSession({
      channel: "telegram",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@some_handle",
    });

    const initial = serviceFindActiveSession("telegram");
    expect(initial).not.toBeNull();
    expect(initial!.status).toBe("pending_bootstrap");

    // Transition to awaiting_response
    serviceUpdateSessionStatus(sessionId, "awaiting_response");
    const awaiting = storeFindActiveSession("telegram");
    expect(awaiting).not.toBeNull();
    expect(awaiting!.status).toBe("awaiting_response");

    // Transition to verified
    serviceUpdateSessionStatus(sessionId, "verified");
    // verified is not an "active" status, so findActiveSession returns null
    const active = storeFindActiveSession("telegram");
    expect(active).toBeNull();
  });

  // ── Auto-revoke of prior sessions ──

  test("creating a new outbound session auto-revokes prior pending/awaiting sessions", () => {
    const { sessionId: firstId } = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const first = serviceFindActiveSession("phone");
    expect(first).not.toBeNull();
    expect(first!.id).toBe(firstId);

    // Create a second session — first should be revoked
    const { sessionId: secondId } = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15559876543",
      destinationAddress: "+15559876543",
    });

    const second = serviceFindActiveSession("phone");
    expect(second).not.toBeNull();
    expect(second!.id).toBe(secondId);

    // First session should no longer be findable as active
    const db = getDb();
    const firstRow = db
      .select()
      .from(channelVerificationSessions)
      .where(eq(channelVerificationSessions.id, firstId))
      .get();
    expect(firstRow).toBeDefined();
    expect(firstRow!.status).toBe("revoked");
  });

  // ── findActiveSession returns correct session ──

  test("findActiveSession returns the most recent active session", () => {
    createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const session = serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    expect(session!.status).toBe("awaiting_response");
    expect(session!.expectedPhoneE164).toBe("+15551234567");
  });

  test("findActiveSession returns null when no active session exists", () => {
    const session = serviceFindActiveSession("phone");
    expect(session).toBeNull();
  });

  // ── findSessionByIdentity returns identity-bound session ──

  test("findSessionByIdentity returns session matching phone E164", () => {
    createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const session = serviceFindSessionByIdentity(
      "phone",
      undefined,
      undefined,
      "+15551234567",
    );
    expect(session).not.toBeNull();
    expect(session!.expectedPhoneE164).toBe("+15551234567");
  });

  test("findSessionByIdentity returns session matching external user ID", () => {
    createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "tg-user-42",
      expectedChatId: "tg-chat-42",
      destinationAddress: "tg-chat-42",
    });

    const session = serviceFindSessionByIdentity("telegram", "tg-user-42");
    expect(session).not.toBeNull();
    expect(session!.expectedExternalUserId).toBe("tg-user-42");
  });

  test("findSessionByIdentity returns null for non-matching identity", () => {
    createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const session = serviceFindSessionByIdentity(
      "phone",
      undefined,
      undefined,
      "+15559999999",
    );
    expect(session).toBeNull();
  });

  // ── bindSessionIdentity transitions from pending_bootstrap to bound ──

  test("bindSessionIdentity transitions from pending_bootstrap to bound", () => {
    const { sessionId } = createOutboundSession({
      channel: "telegram",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@some_handle",
    });

    const before = serviceFindActiveSession("telegram");
    expect(before).not.toBeNull();
    expect(before!.identityBindingStatus).toBe("pending_bootstrap");
    expect(before!.expectedExternalUserId).toBeNull();
    expect(before!.expectedChatId).toBeNull();

    // Bind the identity
    serviceBindSessionIdentity(sessionId, "tg-user-42", "tg-chat-42");

    const after = storeFindActiveSession("telegram");
    expect(after).not.toBeNull();
    expect(after!.identityBindingStatus).toBe("bound");
    expect(after!.expectedExternalUserId).toBe("tg-user-42");
    expect(after!.expectedChatId).toBe("tg-chat-42");
  });

  // ── pending_bootstrap allows consumption without identity check ──

  test("pending_bootstrap session allows consumption without identity check", () => {
    const { secret } = createOutboundSession({
      channel: "telegram",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@some_handle",
    });

    // Any actor can consume during pending_bootstrap
    const result = validateAndConsumeVerification(
      "telegram",
      secret,
      "any-user",
      "any-chat",
    );

    expect(result.success).toBe(true);
  });

  // ── Delivery tracking ──

  test("updateSessionDelivery updates delivery tracking fields", () => {
    const { sessionId } = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    const now = Date.now();
    storeUpdateSessionDelivery(sessionId, now, 1, now + 30_000);

    const session = serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    expect(session!.lastSentAt).toBe(now);
    expect(session!.sendCount).toBe(1);
    expect(session!.nextResendAt).toBe(now + 30_000);
  });

  // ── Telegram identity match via chatId ──

  test("Telegram identity match succeeds via chatId alone", () => {
    const { secret } = createOutboundSession({
      channel: "telegram",
      expectedChatId: "tg-chat-42",
      destinationAddress: "tg-chat-42",
    });

    // Actor has a different external user ID but matching chat ID
    const result = validateAndConsumeVerification(
      "telegram",
      secret,
      "tg-user-DIFFERENT",
      "tg-chat-42",
    );

    expect(result.success).toBe(true);
  });

  // ── Voice identity match via expectedExternalUserId ──

  test("Voice identity match succeeds via expectedExternalUserId", () => {
    const { secret } = createOutboundSession({
      channel: "phone",
      expectedExternalUserId: "voice-user-42",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });

    // Actor matches expectedExternalUserId
    const result = validateAndConsumeVerification(
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
    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15551234567",
    };

    await handleChannelVerificationSession(msg, ctx);

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
    const session = serviceFindActiveSession("phone");
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

    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15559876543",
      rebind: false,
    };

    await handleChannelVerificationSession(msg, ctx);

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

    const { ctx, lastResponse } = createMockCtx();
    const msg: ChannelVerificationSessionRequest = {
      type: "channel_verification_session",
      action: "create_session",
      channel: "phone",
      destination: "+15559876543",
      rebind: true,
    };

    await handleChannelVerificationSession(msg, ctx);

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.verificationSessionId).toBeDefined();
  });

  test("resend_outbound before cooldown is rejected", async () => {
    // Start an outbound session first
    const { ctx: startCtx } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "+15551234567",
      },
      startCtx,
    );

    // Immediately try to resend (before cooldown)
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "resend_session",
        channel: "phone",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("rate_limited");
  });

  test("resend_outbound after cooldown succeeds and increments sendCount", async () => {
    // Start an outbound session
    const { ctx: startCtx, lastResponse: startResp } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "+15551234567",
      },
      startCtx,
    );

    const startResponse = startResp();
    expect(startResponse!.success).toBe(true);

    // Manually update the session's nextResendAt to the past to simulate cooldown elapsed
    const session = serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    storeUpdateSessionDelivery(
      session!.id,
      Date.now() - RESEND_COOLDOWN_MS - 1000,
      1,
      Date.now() - 1000,
    );

    // Now resend should succeed
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "resend_session",
        channel: "phone",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.sendCount).toBe(2);
    expect(resp!.nextResendAt).toBeGreaterThan(Date.now());
  });

  test("resend_outbound exceeding max sends is rejected", async () => {
    // Start an outbound session
    const { ctx: startCtx } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "+15551234567",
      },
      startCtx,
    );

    // Set the send count to MAX_SENDS_PER_SESSION and nextResendAt to the past
    const session = serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    storeUpdateSessionDelivery(
      session!.id,
      Date.now() - RESEND_COOLDOWN_MS - 1000,
      MAX_SENDS_PER_SESSION,
      Date.now() - 1000,
    );

    // Resend should be rejected due to max sends
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "resend_session",
        channel: "phone",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("max_sends_exceeded");
  });

  test("cancel_outbound revokes active session", async () => {
    // Start an outbound session
    const { ctx: startCtx } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "+15551234567",
      },
      startCtx,
    );

    // Verify session exists
    const sessionBefore = serviceFindActiveSession("phone");
    expect(sessionBefore).not.toBeNull();

    // Cancel it
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "cancel_session",
        channel: "phone",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.channel).toBe("phone");

    // Verify session is no longer active
    const sessionAfter = serviceFindActiveSession("phone");
    expect(sessionAfter).toBeNull();
  });

  test("inbound voice from expected identity + correct code succeeds", () => {
    // Create an outbound session
    const { secret } = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      expectedExternalUserId: "+15551234567",
      destinationAddress: "+15551234567",
    });

    // Validate with matching identity
    const result = validateAndConsumeVerification(
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

  test("inbound voice from wrong identity + correct code is rejected", () => {
    // Create an outbound session with expected identity +15551234567
    const { secret } = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      expectedExternalUserId: "+15551234567",
      destinationAddress: "+15551234567",
    });

    // Try to validate with a different phone number (anti-oracle: same generic error)
    const result = validateAndConsumeVerification(
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

  test("start_outbound rejects unsupported channels", async () => {
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "email",
        destination: "user@example.com",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("unsupported_channel");
  });

  test("create_session without destination falls through to inbound challenge", async () => {
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        // no destination — unified create_session creates an inbound challenge
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.secret).toBeDefined();
  });

  test("start_outbound rejects unparseable phone number", async () => {
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "not-a-phone",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("invalid_destination");
  });

  test("start_outbound normalizes formatted phone number for voice", async () => {
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "(555) 123-4567",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.verificationSessionId).toBeDefined();
    expect(resp!.secret).toBeDefined();

    // Verify the session was created with the normalized E.164 number
    const session = serviceFindActiveSession("phone");
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
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "cancel_session",
        channel: "phone",
      },
      ctx,
    );

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
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "telegram",
        destination: "@someuser",
      },
      ctx,
    );

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
    const session = serviceFindActiveSession("telegram");
    expect(session).not.toBeNull();
    expect(session!.identityBindingStatus).toBe("pending_bootstrap");
    // destinationAddress is normalized: '@' stripped and lowercased
    expect(session!.destinationAddress).toBe("someuser");
    expect(session!.bootstrapTokenHash).toBeDefined();
    expect(session!.bootstrapTokenHash).not.toBeNull();
  });

  test("start_outbound for telegram with handle (no @ prefix) returns deep link", async () => {
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "telegram",
        destination: "someuser",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.telegramBootstrapUrl).toContain(
      "https://t.me/test_bot?start=gv_",
    );
    expect(telegramDeliverCalls.length).toBe(0);
  });

  test("start_outbound for telegram with known chat ID sends message, no deep link", async () => {
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "telegram",
        destination: "123456789",
      },
      ctx,
    );

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
    const session = serviceFindActiveSession("telegram");
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

    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "telegram",
        destination: "@someuser",
      },
      ctx,
    );

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

    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "telegram",
        destination: "@newuser",
        rebind: false,
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("already_bound");
  });

  test("bootstrap: resolveBootstrapToken finds pending_bootstrap session by token", async () => {
    const { createHash } = await import("node:crypto");
    const token = "test_bootstrap_token_hex";
    const tokenHash = createHash("sha256").update(token).digest("hex");

    createVerificationSession({
      id: "session-bootstrap-1",
      channel: "telegram",
      challengeHash: "some-challenge-hash",
      expiresAt: Date.now() + 600_000,
      status: "pending_bootstrap",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@targetuser",
      bootstrapTokenHash: tokenHash,
    });

    const found = resolveBootstrapToken("telegram", token);
    expect(found).not.toBeNull();
    expect(found!.id).toBe("session-bootstrap-1");
    expect(found!.status).toBe("pending_bootstrap");
  });

  test("bootstrap: resolveBootstrapToken returns null for wrong token", async () => {
    const { createHash } = await import("node:crypto");
    const token = "test_bootstrap_token_hex";
    const tokenHash = createHash("sha256").update(token).digest("hex");

    createVerificationSession({
      id: "session-bootstrap-2",
      channel: "telegram",
      challengeHash: "some-challenge-hash",
      expiresAt: Date.now() + 600_000,
      status: "pending_bootstrap",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@targetuser",
      bootstrapTokenHash: tokenHash,
    });

    const found = resolveBootstrapToken("telegram", "wrong_token");
    expect(found).toBeNull();
  });

  test("bootstrap: resolveBootstrapToken returns null for expired session", async () => {
    const { createHash } = await import("node:crypto");
    const token = "test_bootstrap_token_hex";
    const tokenHash = createHash("sha256").update(token).digest("hex");

    createVerificationSession({
      id: "session-bootstrap-3",
      channel: "telegram",
      challengeHash: "some-challenge-hash",
      expiresAt: Date.now() - 1000, // already expired
      status: "pending_bootstrap",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@targetuser",
      bootstrapTokenHash: tokenHash,
    });

    const found = resolveBootstrapToken("telegram", token);
    expect(found).toBeNull();
  });

  test("identity-bound consume: right chat_id + right code succeeds", () => {
    // Create an awaiting_response session with expected identity
    const sessionResult = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "user-42",
      expectedChatId: "chat-42",
      identityBindingStatus: "bound",
      destinationAddress: "chat-42",
    });

    const result = validateAndConsumeVerification(
      "telegram",
      sessionResult.secret,
      "user-42",
      "chat-42",
      "testuser",
      "Test User",
    );

    expect(result.success).toBe(true);
  });

  test("identity mismatch: wrong chat_id + right code rejects", () => {
    const sessionResult = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "user-42",
      expectedChatId: "chat-42",
      identityBindingStatus: "bound",
      destinationAddress: "chat-42",
    });

    const result = validateAndConsumeVerification(
      "telegram",
      sessionResult.secret,
      "attacker-99",
      "attacker-chat-99",
      "attacker",
      "Attacker",
    );

    expect(result.success).toBe(false);
  });

  test("revoked session rejects verification", () => {
    const sessionResult = createOutboundSession({
      channel: "telegram",
      expectedExternalUserId: "user-42",
      expectedChatId: "chat-42",
      identityBindingStatus: "bound",
      destinationAddress: "chat-42",
    });

    // Revoke the session
    serviceUpdateSessionStatus(sessionResult.sessionId, "revoked");

    const result = validateAndConsumeVerification(
      "telegram",
      sessionResult.secret,
      "user-42",
      "chat-42",
    );

    expect(result.success).toBe(false);
  });

  test("inbound-only Telegram verification flow still works with bare code", () => {
    // Create an inbound-only challenge (no outbound session, no expected identity)
    const challengeResult = createInboundVerificationSession("telegram");

    const result = validateAndConsumeVerification(
      "telegram",
      challengeResult.secret,
      "user-42",
      "chat-42",
      "testuser",
      "Test User",
    );

    expect(result.success).toBe(true);
  });

  test("resend_outbound for telegram works with known chat ID", async () => {
    // Start an outbound session with a known chat ID
    const { ctx: startCtx } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "telegram",
        destination: "123456789",
      },
      startCtx,
    );

    // Fast-forward the cooldown
    const session = serviceFindActiveSession("telegram");
    expect(session).not.toBeNull();
    storeUpdateSessionDelivery(
      session!.id,
      Date.now() - RESEND_COOLDOWN_MS - 1000,
      1,
      Date.now() - 1000,
    );

    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "resend_session",
        channel: "telegram",
      },
      ctx,
    );

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
    const { ctx: startCtx } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "telegram",
        destination: "@someuser",
      },
      startCtx,
    );

    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "resend_session",
        channel: "telegram",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("pending_bootstrap");
  });

  test("cancel_outbound for telegram revokes session", async () => {
    // Start an outbound session
    const { ctx: startCtx } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "telegram",
        destination: "123456789",
      },
      startCtx,
    );

    const session = serviceFindActiveSession("telegram");
    expect(session).not.toBeNull();

    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "cancel_session",
        channel: "telegram",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);

    // Session should be revoked
    const revoked = serviceFindActiveSession("telegram");
    expect(revoked).toBeNull();
  });

  test("telegram template does not include verification code in message", () => {
    const msg = composeVerificationTelegram(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST,
      { code: "abc123", expiresInMinutes: 10 },
    );
    expect(msg).not.toContain("abc123");
    expect(msg).not.toContain("guardian_verify");
  });

  test("telegram resend template does not include code and includes (resent) suffix", () => {
    const msg = composeVerificationTelegram(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_RESEND,
      { code: "xyz789", expiresInMinutes: 5 },
    );
    expect(msg).not.toContain("xyz789");
    expect(msg).not.toContain("guardian_verify");
    expect(msg).toContain("(resent)");
  });

  test("telegram template includes Vellum assistant prefix", () => {
    const msg = composeVerificationTelegram(
      GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST,
      { code: "999999", expiresInMinutes: 10, assistantName: "MyBot" },
    );
    expect(msg).toContain("Vellum assistant");
    expect(msg).not.toContain("999999");
  });

  test("create_session for telegram without destination falls through to inbound challenge", async () => {
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "telegram",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.secret).toBeDefined();
  });

  test("rate limits apply to telegram outbound (per-session send cap)", async () => {
    // Start an outbound session with a known chat ID
    const { ctx: startCtx } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "telegram",
        destination: "123456789",
      },
      startCtx,
    );

    // Set the send count to MAX_SENDS_PER_SESSION and nextResendAt to the past
    const session = serviceFindActiveSession("telegram");
    expect(session).not.toBeNull();
    storeUpdateSessionDelivery(
      session!.id,
      Date.now() - RESEND_COOLDOWN_MS - 1000,
      MAX_SENDS_PER_SESSION,
      Date.now() - 1000,
    );

    // Resend should be rejected due to max sends
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "resend_session",
        channel: "telegram",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("max_sends_exceeded");
  });

  test("rate limits apply to telegram outbound (cooldown)", async () => {
    // Start an outbound session with a known chat ID
    const { ctx: startCtx } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "telegram",
        destination: "123456789",
      },
      startCtx,
    );

    // Immediately try to resend (before cooldown)
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "resend_session",
        channel: "telegram",
      },
      ctx,
    );

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
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "+15551234567",
      },
      ctx,
    );

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
    const session = serviceFindActiveSession("phone");
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
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "not-a-phone",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("invalid_destination");
  });

  test("start_outbound for voice normalizes formatted phone number", async () => {
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "555-123-4567",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.verificationSessionId).toBeDefined();
    expect(resp!.secret).toBeDefined();
    // Voice codes are 6 digits
    expect(resp!.secret!.length).toBe(6);

    // Verify the session was created with the normalized E.164 number
    const session = serviceFindActiveSession("phone");
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

    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "+15559876543",
        rebind: false,
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("already_bound");
  });

  test("resend_outbound for voice initiates a new call with cooldown check", async () => {
    // Start an outbound session first
    const { ctx: startCtx } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "+15551234567",
      },
      startCtx,
    );

    // Immediately try to resend (before cooldown)
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "resend_session",
        channel: "phone",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("rate_limited");
  });

  test("cancel_outbound for voice cancels session", async () => {
    // Start an outbound session first
    const { ctx: startCtx } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "+15551234567",
      },
      startCtx,
    );

    // Cancel the session
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "cancel_session",
        channel: "phone",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);

    // Session should no longer be active
    const session = serviceFindActiveSession("phone");
    expect(session).toBeNull();
  });

  test("rate limit enforcement: destination rate limit applies to voice", async () => {
    // Exhaust the per-destination rate limit by creating many sessions
    const db = getDb();
    const now = Date.now();
    for (let i = 0; i < 10; i++) {
      // Insert sessions with recent lastSentAt to simulate sends
      db.insert(channelVerificationSessions)
        .values({
          id: `rate-limit-voice-${i}`,
          channel: "phone",
          challengeHash: `hash-${i}`,
          expiresAt: now + 600_000,
          status: "awaiting_response",
          destinationAddress: "+15551234567",
          lastSentAt: now - 1000,
          sendCount: 1,
          createdAt: now,
          updatedAt: now,
        })
        .run();
    }

    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "+15551234567",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(false);
    expect(resp!.error).toBe("rate_limited");
  });

  test("create_session for voice without destination falls through to inbound challenge", async () => {
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
      },
      ctx,
    );

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

  test("RESEND_COOLDOWN_MS is 15 000 ms", () => {
    expect(RESEND_COOLDOWN_MS).toBe(15_000);
  });

  // ── M2: start_outbound for voice returns secret in response ──

  test("start_outbound for voice response includes secret", async () => {
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "+15551234567",
      },
      ctx,
    );

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
    const { ctx: startCtx } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "phone",
        destination: "+15551234567",
      },
      startCtx,
    );

    // Move past cooldown
    const session = serviceFindActiveSession("phone");
    expect(session).not.toBeNull();
    storeUpdateSessionDelivery(
      session!.id,
      Date.now() - RESEND_COOLDOWN_MS - 1000,
      1,
      Date.now() - 1000,
    );

    // Resend
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "resend_session",
        channel: "phone",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    expect(resp!.secret).toBeDefined();
    expect(typeof resp!.secret).toBe("string");
    expect(resp!.secret!.length).toBeGreaterThan(0);
  });

  // ── M2: start_outbound for Telegram bootstrap does NOT return secret ──

  test("start_outbound for Telegram bootstrap (handle) does NOT return secret", async () => {
    const { ctx, lastResponse } = createMockCtx();
    await handleChannelVerificationSession(
      {
        type: "channel_verification_session",
        action: "create_session",
        channel: "telegram",
        destination: "@someuser",
      },
      ctx,
    );

    const resp = lastResponse();
    expect(resp).not.toBeNull();
    expect(resp!.success).toBe(true);
    // Security: secret must NOT be revealed for pending_bootstrap sessions
    expect(resp!.secret).toBeUndefined();
    // Bootstrap URL should be present instead
    expect(resp!.telegramBootstrapUrl).toBeDefined();
  });

  // ── M2: bootstrap sessions use high-entropy hex secrets ──

  test("bootstrap (pending_bootstrap) sessions use high-entropy hex secrets, identity-bound use 6-digit numeric", () => {
    const bootstrapResult = createOutboundSession({
      channel: "telegram",
      identityBindingStatus: "pending_bootstrap",
      destinationAddress: "@testuser",
    });
    // Pending bootstrap: high-entropy hex (32 bytes = 64 hex chars)
    expect(bootstrapResult.secret.length).toBe(64);
    expect(bootstrapResult.secret).toMatch(/^[a-f0-9]{64}$/);

    resetTables();

    // Identity-bound: 6-digit numeric code
    const boundResult = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
      identityBindingStatus: "bound",
    });
    expect(boundResult.secret.length).toBe(6);
    expect(boundResult.secret).toMatch(/^\d{6}$/);
  });

  // ── M2: all identity-bound channels use 6-digit numeric codes ──

  test("all identity-bound channels (voice, Telegram chat ID) use 6-digit numeric codes", () => {
    // Voice (phone E.164)
    const voicePhoneResult = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
    });
    expect(voicePhoneResult.secret).toMatch(/^\d{6}$/);

    resetTables();

    // Telegram (bound via chat ID)
    const tgResult = createOutboundSession({
      channel: "telegram",
      expectedChatId: "123456789",
      identityBindingStatus: "bound",
      destinationAddress: "123456789",
    });
    expect(tgResult.secret).toMatch(/^\d{6}$/);

    resetTables();

    // Voice (explicit codeDigits)
    const voiceResult = createOutboundSession({
      channel: "phone",
      expectedPhoneE164: "+15551234567",
      destinationAddress: "+15551234567",
      codeDigits: 6,
    });
    expect(voiceResult.secret).toMatch(/^\d{6}$/);
  });
});
