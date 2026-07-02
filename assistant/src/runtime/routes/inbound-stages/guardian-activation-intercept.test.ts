import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

// ---------------------------------------------------------------------------
// Mocks — must be set up before importing the module under test
// ---------------------------------------------------------------------------

// Gateway guardian-delivery list: empty = unbound, one entry = bound,
// null = gateway unreachable.
let mockGuardianList: Array<Record<string, unknown>> | null = [];
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

mock.module("../../../contacts/guardian-delivery-reader.js", () => ({
  // Existence guard reads fresh (uncached) — only this variant is stubbed.
  getGuardianDeliveryFresh: () => Promise.resolve(mockGuardianList),
  guardianForChannel: (
    list: Array<{ channelType: string; status: string }>,
    channelType: string,
  ) =>
    list.find((g) => g.channelType === channelType && g.status === "active"),
}));

// Gateway-backed session client (async IPC); the throw toggles simulate an
// unreachable gateway, where the client wrappers throw transport errors.
let findActiveSessionThrows = false;
let createOutboundSessionThrows = false;
let createOutboundSessionConflicts = false;
mock.module("../../../channels/gateway-verification-sessions.js", () => ({
  createOutboundSessionConditional: async (params: unknown) => {
    if (createOutboundSessionThrows) {
      throw new Error("gateway unreachable");
    }
    createOutboundSessionCalls.push(params);
    if (createOutboundSessionConflicts) {
      return { conflict: true, reason: "active_session_exists" };
    }
    return mockSessionResult;
  },
  findActiveSession: async () => {
    if (findActiveSessionThrows) {
      throw new Error("gateway unreachable");
    }
    return mockActiveSession;
  },
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
    mockGuardianList = [];
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
    findActiveSessionThrows = false;
    createOutboundSessionThrows = false;
    createOutboundSessionConflicts = false;
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

    // Verify createOutboundSessionConditional was called with correct params
    expect(createOutboundSessionCalls).toHaveLength(1);
    expect(createOutboundSessionCalls[0]).toEqual({
      channel: "telegram",
      expectedExternalUserId: "user-42",
      expectedChatId: "chat-123",
      identityBindingStatus: "bound",
      destinationAddress: "chat-123",
      verificationPurpose: "guardian",
      // No session was read: the create is a gateway-side create-if-absent.
      ifNoneActive: true,
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
    mockGuardianList = [{ channelType: "telegram", status: "active" }];

    const result = await handleGuardianActivationIntercept(makeParams());
    expect(result).toBeNull();
    expect(createOutboundSessionCalls).toHaveLength(0);
  });

  test("null guardian list (gateway unreachable) does NOT auto-start", async () => {
    mockGuardianList = null;

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
    // Deliberate supersede: the create-if-absent guard is omitted so the
    // stale session gets revoked.
    expect(
      (createOutboundSessionCalls[0] as Record<string, unknown>).ifNoneActive,
    ).toBeUndefined();
    expect(emitNotificationSignalCalls).toHaveLength(1);
  });

  test("losing the concurrent create race does not invalidate the first activation's code", async () => {
    // Both bare /starts read "no active session"; the gateway-side
    // create-if-absent makes the second one conflict instead of minting.
    createOutboundSessionConflicts = true;

    const result = await handleGuardianActivationIntercept(makeParams());

    // Mirrors the dedup path: pending response, "already in progress"
    // reply, and no signal carrying a superseding code.
    expect(result).toEqual({
      accepted: true,
      guardianActivationPending: true,
    });
    expect(createOutboundSessionCalls).toHaveLength(1);
    expect(deliverChannelReplyCalls).toHaveLength(1);
    expect(deliverChannelReplyCalls[0][1]).toEqual({
      chatId: "chat-123",
      text: "A verification is already in progress. Check your assistant app for the code and enter it here.",
      assistantId: "self",
    });
    expect(emitNotificationSignalCalls).toHaveLength(0);
  });

  test("gateway unreachable on the session read skips auto-activation without throwing", async () => {
    findActiveSessionThrows = true;

    const result = await handleGuardianActivationIntercept(makeParams());

    // Degrades to the normal pipeline: no session, no reply, no signal.
    expect(result).toBeNull();
    expect(createOutboundSessionCalls).toHaveLength(0);
    expect(deliverChannelReplyCalls).toHaveLength(0);
    expect(emitNotificationSignalCalls).toHaveLength(0);
  });

  test("gateway unreachable on session creation skips auto-activation and stays retryable", async () => {
    createOutboundSessionThrows = true;
    const params = makeParams({ externalMessageId: "retry-after-outage" });

    const result = await handleGuardianActivationIntercept(params);
    expect(result).toBeNull();
    expect(emitNotificationSignalCalls).toHaveLength(0);

    // Not marked processed on failure: the next webhook retry succeeds once
    // the gateway is reachable again.
    createOutboundSessionThrows = false;
    const retry = await handleGuardianActivationIntercept(params);
    expect(retry).toEqual({ accepted: true, guardianActivation: true });
    expect(createOutboundSessionCalls).toHaveLength(1);
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
