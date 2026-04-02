import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

let mockGuardian: { contact: unknown; channel: unknown } | null = null;
let mockActiveSession: unknown = null;
let mockSessionResult = {
  sessionId: "sess-1",
  secret: "123456",
  challengeHash: "hash-1",
  expiresAt: Date.now() + 600_000,
  ttlSeconds: 600,
};

const mockCreateOutboundSession = mock(() => mockSessionResult);
const mockFindActiveSession = mock(() => mockActiveSession);
const mockDeliverChannelReply = mock(async () => ({ ok: true }));
const mockEmitNotificationSignal = mock(async () => ({
  signalId: "sig-1",
  deduplicated: false,
  dispatched: true,
  reason: "ok",
  deliveryResults: [],
}));

mock.module("../../../contacts/contact-store.js", () => ({
  findGuardianForChannel: () => mockGuardian,
}));

mock.module("../../channel-verification-service.js", () => ({
  createOutboundSession: (...args: unknown[]) =>
    mockCreateOutboundSession(...args),
  findActiveSession: (...args: unknown[]) => mockFindActiveSession(...args),
}));

mock.module("../../gateway-client.js", () => ({
  deliverChannelReply: (...args: unknown[]) => mockDeliverChannelReply(...args),
}));

mock.module("../../../notifications/emit-signal.js", () => ({
  emitNotificationSignal: (...args: unknown[]) =>
    mockEmitNotificationSignal(...args),
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
  return {
    sourceChannel: "telegram" as const,
    conversationExternalId: "chat-123",
    rawSenderId: "user-42",
    canonicalSenderId: "user-42",
    actorDisplayName: "Alice",
    actorUsername: "alice",
    sourceMetadata: { commandIntent: { type: "start" } },
    replyCallbackUrl: "https://gateway/reply",
    mintBearerToken: () => "token-123",
    assistantId: "self",
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
    mockCreateOutboundSession.mockClear();
    mockFindActiveSession.mockClear();
    mockDeliverChannelReply.mockClear();
    mockEmitNotificationSignal.mockClear();
  });

  afterEach(() => {
    mockCreateOutboundSession.mockClear();
    mockFindActiveSession.mockClear();
    mockDeliverChannelReply.mockClear();
    mockEmitNotificationSignal.mockClear();
  });

  test("bare /start with no guardian creates session and returns early", async () => {
    const result = await handleGuardianActivationIntercept(makeParams());

    expect(result).not.toBeNull();
    const body = await result!.json();
    expect(body).toEqual({ accepted: true, guardianActivation: true });

    // Verify createOutboundSession was called with correct params
    expect(mockCreateOutboundSession).toHaveBeenCalledTimes(1);
    const sessionArgs = mockCreateOutboundSession.mock.calls[0][0];
    expect(sessionArgs).toEqual({
      channel: "telegram",
      expectedExternalUserId: "user-42",
      expectedChatId: "chat-123",
      identityBindingStatus: "bound",
      destinationAddress: "chat-123",
      verificationPurpose: "guardian",
    });

    // Verify deliverChannelReply was called with the welcome/verify message
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);
    const replyArgs = mockDeliverChannelReply.mock.calls[0];
    expect(replyArgs[0]).toBe("https://gateway/reply");
    expect(replyArgs[1]).toEqual({
      chatId: "chat-123",
      text: "Welcome! To verify your identity as guardian, check your assistant app for a verification code and enter it here.",
      assistantId: "self",
    });

    // Verify emitNotificationSignal was called with guardian.channel_activation
    expect(mockEmitNotificationSignal).toHaveBeenCalledTimes(1);
    const signalArgs = mockEmitNotificationSignal.mock.calls[0][0];
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
    expect(mockCreateOutboundSession).not.toHaveBeenCalled();
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
    expect(mockCreateOutboundSession).not.toHaveBeenCalled();
  });

  test("non-/start message returns null", async () => {
    const result = await handleGuardianActivationIntercept(
      makeParams({
        sourceMetadata: { commandIntent: { type: "other" } },
      }),
    );
    expect(result).toBeNull();
    expect(mockCreateOutboundSession).not.toHaveBeenCalled();
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
    expect(mockCreateOutboundSession).not.toHaveBeenCalled();
  });

  test("non-telegram channel returns null", async () => {
    const result = await handleGuardianActivationIntercept(
      makeParams({ sourceChannel: "slack" as any }),
    );
    expect(result).toBeNull();
    expect(mockCreateOutboundSession).not.toHaveBeenCalled();
  });

  test("missing sender ID returns null", async () => {
    const result = await handleGuardianActivationIntercept(
      makeParams({ rawSenderId: undefined }),
    );
    expect(result).toBeNull();
    expect(mockCreateOutboundSession).not.toHaveBeenCalled();
  });

  test("existing active session sends 'already in progress' reply", async () => {
    mockActiveSession = {
      id: "existing-sess",
      channel: "telegram",
      status: "awaiting_response",
    };

    const result = await handleGuardianActivationIntercept(makeParams());

    expect(result).not.toBeNull();
    const body = await result!.json();
    expect(body).toEqual({ accepted: true, guardianActivationPending: true });

    // createOutboundSession should NOT be called
    expect(mockCreateOutboundSession).not.toHaveBeenCalled();

    // deliverChannelReply should be called with the "already in progress" message
    expect(mockDeliverChannelReply).toHaveBeenCalledTimes(1);
    const replyArgs = mockDeliverChannelReply.mock.calls[0];
    expect(replyArgs[1]).toEqual({
      chatId: "chat-123",
      text: "A verification is already in progress. Check your assistant app for the code and enter it here.",
      assistantId: "self",
    });

    // emitNotificationSignal should NOT be called
    expect(mockEmitNotificationSignal).not.toHaveBeenCalled();
  });
});
