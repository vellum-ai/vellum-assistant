import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

let mockGuardian: { contact: unknown; channel: unknown } | null = null;
let mockActiveSession: Record<string, unknown> | null = null;
let mockSessionResult = {
  sessionId: "sess-1",
  secret: "123456",
  challengeHash: "hash-1",
  expiresAt: Date.now() + 600_000,
  ttlSeconds: 600,
};

// Track calls manually to avoid TypeScript issues with mock() generics
let createOutboundSessionCalls: unknown[] = [];
let deliverChannelReplyCalls: unknown[][] = [];
let emitNotificationSignalCalls: unknown[] = [];
let messageIdCounter = 0;

mock.module("../../../contacts/contact-store.js", () => ({
  findGuardianForChannel: () => mockGuardian,
}));

mock.module("../../channel-verification-service.js", () => ({
  createOutboundSession: (params: unknown) => {
    createOutboundSessionCalls.push(params);
    return mockSessionResult;
  },
  findActiveSession: () => mockActiveSession,
}));

mock.module("../../gateway-client.js", () => ({
  deliverChannelReply: (url: unknown, payload: unknown, token: unknown) => {
    deliverChannelReplyCalls.push([url, payload, token]);
    return Promise.resolve({ ok: true });
  },
}));

mock.module("../../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: (params: unknown) => {
    emitNotificationSignalCalls.push(params);
    return Promise.resolve({
      signalId: "sig-1",
      deduplicated: false,
      dispatched: true,
      reason: "ok",
      deliveryResults: [],
    });
  },
}));

mock.module("../../../util/logger.js", () => ({
  getLogger: () => ({
    debug: () => {},
    info: () => {},
    warn: () => {},
    error: () => {},
  }),
}));

// Import after mocks are installed
const { handleGuardianActivationIntercept } =
  await import("./guardian-activation-intercept.js");

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeParams(
  overrides: Partial<
    Parameters<typeof handleGuardianActivationIntercept>[0]
  > = {},
) {
  messageIdCounter++;
  return {
    sourceChannel: "telegram" as const,
    conversationExternalId: "chat-123",
    rawSenderId: "user-42",
    canonicalSenderId: "user-42",
    actorDisplayName: "Alice",
    actorUsername: "alice",
    sourceMetadata: { commandIntent: { type: "start" } },
    replyCallbackUrl: "https://gateway/reply",
    assistantId: "self",
    externalMessageId: `msg-${messageIdCounter}`,
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("handleGuardianActivationIntercept", () => {
  beforeEach(() => {
    mockGuardian = null;
    mockActiveSession = null;
    mockSessionResult = {
      sessionId: "sess-1",
      secret: "123456",
      challengeHash: "hash-1",
      expiresAt: Date.now() + 600_000,
      ttlSeconds: 600,
    };
    createOutboundSessionCalls = [];
    deliverChannelReplyCalls = [];
    emitNotificationSignalCalls = [];
  });

  afterEach(() => {
    createOutboundSessionCalls = [];
    deliverChannelReplyCalls = [];
    emitNotificationSignalCalls = [];
  });

  test("bare /start with no guardian creates session and returns early", async () => {
    const result = await handleGuardianActivationIntercept(makeParams());

    expect(result).not.toBeNull();
    const body = result!;
    expect(body).toEqual({ accepted: true, guardianActivation: true });

    // Verify createOutboundSession was called with correct params
    expect(createOutboundSessionCalls).toHaveLength(1);
    expect(createOutboundSessionCalls[0]).toEqual({
      channel: "telegram",
      expectedExternalUserId: "user-42",
      expectedChatId: "chat-123",
      identityBindingStatus: "bound",
      destinationAddress: "chat-123",
      verificationPurpose: "guardian",
    });

    // Verify deliverChannelReply was called with the welcome/verify message
    expect(deliverChannelReplyCalls).toHaveLength(1);
    expect(deliverChannelReplyCalls[0][0]).toBe("https://gateway/reply");
    expect(deliverChannelReplyCalls[0][1]).toEqual({
      chatId: "chat-123",
      text: "Welcome! To verify your identity as guardian, check your assistant app for a verification code and enter it here.",
      assistantId: "self",
    });

    // Verify emitNotificationSignal was called with guardian.channel_activation
    expect(emitNotificationSignalCalls).toHaveLength(1);
    const signalArgs = emitNotificationSignalCalls[0] as Record<string, any>;
    expect(signalArgs.sourceEventName).toBe("guardian.channel_activation");
    expect(signalArgs.contextPayload.verificationCode).toBe("123456");
    expect(signalArgs.contextPayload.sourceChannel).toBe("telegram");
    expect(signalArgs.contextPayload.actorExternalId).toBe("user-42");
    expect(signalArgs.contextPayload.sessionId).toBe("sess-1");
    expect(signalArgs.dedupeKey).toBe("guardian-activation:sess-1");
  });

  test("bare /start with existing guardian returns null", async () => {
    mockGuardian = {
      contact: { id: "contact-1", role: "guardian" },
      channel: { id: "ch-1", type: "telegram" },
    };

    const result = await handleGuardianActivationIntercept(makeParams());
    expect(result).toBeNull();
    expect(createOutboundSessionCalls).toHaveLength(0);
  });

  test("/start with payload returns null", async () => {
    const result = await handleGuardianActivationIntercept(
      makeParams({
        sourceMetadata: {
          commandIntent: { type: "start", payload: "gv_token" },
        },
      }),
    );
    expect(result).toBeNull();
    expect(createOutboundSessionCalls).toHaveLength(0);
  });

  test("non-/start message returns null", async () => {
    const result = await handleGuardianActivationIntercept(
      makeParams({
        sourceMetadata: { commandIntent: { type: "other" } },
      }),
    );
    expect(result).toBeNull();
    expect(createOutboundSessionCalls).toHaveLength(0);
  });

  test("no commandIntent returns null", async () => {
    const result = await handleGuardianActivationIntercept(
      makeParams({ sourceMetadata: {} }),
    );
    expect(result).toBeNull();

    const result2 = await handleGuardianActivationIntercept(
      makeParams({ sourceMetadata: undefined }),
    );
    expect(result2).toBeNull();
    expect(createOutboundSessionCalls).toHaveLength(0);
  });

  test("non-telegram channel returns null", async () => {
    const result = await handleGuardianActivationIntercept(
      makeParams({ sourceChannel: "slack" as any }),
    );
    expect(result).toBeNull();
    expect(createOutboundSessionCalls).toHaveLength(0);
  });

  test("missing sender ID returns null", async () => {
    const result = await handleGuardianActivationIntercept(
      makeParams({ rawSenderId: undefined }),
    );
    expect(result).toBeNull();
    expect(createOutboundSessionCalls).toHaveLength(0);
  });

  test("existing active session from same sender sends 'already in progress' reply", async () => {
    mockActiveSession = {
      id: "existing-sess",
      channel: "telegram",
      status: "awaiting_response",
      expectedExternalUserId: "user-42",
      expectedChatId: "chat-123",
    };

    const result = await handleGuardianActivationIntercept(makeParams());

    expect(result).not.toBeNull();
    const body = result!;
    expect(body).toEqual({ accepted: true, guardianActivationPending: true });

    // createOutboundSession should NOT be called
    expect(createOutboundSessionCalls).toHaveLength(0);

    // deliverChannelReply should be called with the "already in progress" message
    expect(deliverChannelReplyCalls).toHaveLength(1);
    expect(deliverChannelReplyCalls[0][1]).toEqual({
      chatId: "chat-123",
      text: "A verification is already in progress. Check your assistant app for the code and enter it here.",
      assistantId: "self",
    });

    // emitNotificationSignal should NOT be called
    expect(emitNotificationSignalCalls).toHaveLength(0);
  });

  test("existing active session from different sender allows superseding", async () => {
    mockActiveSession = {
      id: "existing-sess",
      channel: "telegram",
      status: "awaiting_response",
      expectedExternalUserId: "user-OTHER",
      expectedChatId: "chat-OTHER",
    };

    const result = await handleGuardianActivationIntercept(makeParams());

    // Should proceed and create a new session (superseding the stale one)
    expect(result).not.toBeNull();
    const body = result!;
    expect(body).toEqual({ accepted: true, guardianActivation: true });
    expect(createOutboundSessionCalls).toHaveLength(1);
    expect(emitNotificationSignalCalls).toHaveLength(1);
  });

  test("duplicate webhook retry is silently deduped", async () => {
    const params = makeParams({ externalMessageId: "dedup-test-msg" });

    // First call should process normally
    const result1 = await handleGuardianActivationIntercept(params);
    expect(result1).not.toBeNull();
    const body1 = result1!;
    expect(body1).toEqual({ accepted: true, guardianActivation: true });
    expect(createOutboundSessionCalls).toHaveLength(1);
    expect(deliverChannelReplyCalls).toHaveLength(1);
    expect(emitNotificationSignalCalls).toHaveLength(1);

    // Second call with same externalMessageId should be deduped
    const result2 = await handleGuardianActivationIntercept(params);
    expect(result2).not.toBeNull();
    const body2 = result2!;
    expect(body2).toEqual({ accepted: true, guardianActivation: true });

    // No additional session/reply/signal calls
    expect(createOutboundSessionCalls).toHaveLength(1);
    expect(deliverChannelReplyCalls).toHaveLength(1);
    expect(emitNotificationSignalCalls).toHaveLength(1);
  });
});
