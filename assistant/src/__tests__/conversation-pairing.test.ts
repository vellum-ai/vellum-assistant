/**
 * Regression tests for notification conversation pairing.
 *
 * Validates that pairDeliveryWithConversation materializes conversations
 * and messages according to the channel's conversation strategy, handles
 * thread reuse decisions, and that errors in pairing never break the
 * notification pipeline.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

// ── Mocks — declared before imports that depend on them ─────────────

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

let mockConversationId = "conv-001";
let mockMessageId = "msg-001";
let createConversationShouldThrow = false;
let addMessageShouldThrow = false;

/** Simulated existing conversations for getConversation mock. */
let mockExistingConversations: Record<
  string,
  { id: string; source: string; title: string | null }
> = {};

const createConversationMock = mock((_opts?: unknown) => {
  if (createConversationShouldThrow) throw new Error("DB write failed");
  return { id: mockConversationId };
});

const addMessageMock = mock(
  (
    _conversationId: string,
    _role: string,
    _content: string,
    _metadata?: unknown,
    _opts?: unknown,
  ) => {
    if (addMessageShouldThrow) throw new Error("DB write failed");
    return { id: mockMessageId };
  },
);

const getConversationMock = mock((id: string) => {
  return mockExistingConversations[id] ?? null;
});

mock.module("../memory/conversation-store.js", () => ({
  getConversationThreadType: () => "default",
  setConversationOriginChannelIfUnset: () => {},
  updateConversationContextWindow: () => {},
  deleteMessageById: () => {},
  updateConversationTitle: () => {},
  updateConversationUsage: () => {},
  getMessages: () => [],
  provenanceFromTrustContext: () => ({
    source: "user",
    trustContext: undefined,
  }),
  getConversationOriginInterface: () => null,
  getConversationOriginChannel: () => null,
  createConversation: createConversationMock,
  addMessage: addMessageMock,
  getConversation: getConversationMock,
}));

import { pairDeliveryWithConversation } from "../notifications/conversation-pairing.js";
import type { NotificationSignal } from "../notifications/signal.js";
import type {
  NotificationChannel,
  RenderedChannelCopy,
  ThreadAction,
} from "../notifications/types.js";

// ── Test helpers ────────────────────────────────────────────────────────

function makeSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: "sig-test",
    createdAt: Date.now(),
    sourceChannel: "scheduler",
    sourceSessionId: "sess-1",
    sourceEventName: "test.event",
    contextPayload: {},
    attentionHints: {
      requiresAction: false,
      urgency: "medium",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
    ...overrides,
  };
}

function makeCopy(
  overrides?: Partial<RenderedChannelCopy>,
): RenderedChannelCopy {
  return {
    title: "Test Notification",
    body: "Something happened.",
    ...overrides,
  };
}

describe("pairDeliveryWithConversation", () => {
  beforeEach(() => {
    createConversationMock.mockClear();
    addMessageMock.mockClear();
    getConversationMock.mockClear();
    mockConversationId = "conv-001";
    mockMessageId = "msg-001";
    createConversationShouldThrow = false;
    addMessageShouldThrow = false;
    mockExistingConversations = {};
  });

  // ── start_new_conversation (vellum) ─────────────────────────────────

  test("creates a conversation and message for start_new_conversation strategy", async () => {
    const signal = makeSignal();
    const copy = makeCopy({ threadTitle: "Alert Thread" });

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.messageId).toBe("msg-001");
    expect(result.strategy).toBe("start_new_conversation");
    expect(result.createdNewConversation).toBe(true);
    expect(result.threadDecisionFallbackUsed).toBe(false);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    const callArgs = createConversationMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(callArgs.threadType).toBe("standard");
  });

  test("uses threadTitle for conversation title when available", async () => {
    const signal = makeSignal();
    const copy = makeCopy({ threadTitle: "Custom Thread Title" });

    await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
    );

    // Verify createConversation was called with the thread title
    const callArgs = createConversationMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(callArgs.title).toBe("Custom Thread Title");
  });

  test("falls back to copy title when threadTitle is absent", async () => {
    const signal = makeSignal();
    const copy = makeCopy({ title: "Notification Title" });

    await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
    );

    const callArgs = createConversationMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(callArgs.title).toBe("Notification Title");
  });

  test("uses threadSeedMessage for message content when present and sane", async () => {
    const signal = makeSignal();
    const copy = makeCopy({
      threadSeedMessage: "Custom seed message with enough length",
    });

    await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
    );

    // addMessage second arg is role, third is content
    const contentArg = addMessageMock.mock.calls[0]![2];
    expect(contentArg).toBe("Custom seed message with enough length");
  });

  test("rejects threadSeedMessage that is a JSON dump and uses runtime composer", async () => {
    const signal = makeSignal({
      sourceEventName: "reminder.fired",
      contextPayload: { message: "Daily standup" },
    });
    const copy = makeCopy({
      title: "Reminder",
      body: "Daily standup",
      threadSeedMessage: '{"raw": "json dump payload"}',
    });

    await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
    );

    const contentArg = addMessageMock.mock.calls[0]![2] as string;
    // Should NOT be the JSON dump
    expect(contentArg).not.toContain('"raw"');
    // Should be the runtime-composed seed from copy.title/body
    expect(contentArg).toContain("Reminder");
  });

  test("rejects very short threadSeedMessage and uses runtime composer", async () => {
    const signal = makeSignal({
      sourceEventName: "reminder.fired",
      contextPayload: { message: "Test" },
    });
    const copy = makeCopy({
      title: "Reminder",
      body: "Test reminder",
      threadSeedMessage: "Hi",
    });

    await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
    );

    const contentArg = addMessageMock.mock.calls[0]![2] as string;
    expect(contentArg).not.toBe("Hi");
    // Runtime composer builds from copy.title/body
    expect(contentArg).toContain("Reminder");
  });

  test("passes skipIndexing option to addMessage", async () => {
    const signal = makeSignal();
    const copy = makeCopy();

    await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
    );

    const optsArg = addMessageMock.mock.calls[0]![4] as Record<string, unknown>;
    expect(optsArg.skipIndexing).toBe(true);
  });

  // ── continue_existing_conversation (telegram) ─────────────────────

  test("creates a conversation for continue_existing_conversation strategy", async () => {
    const signal = makeSignal();
    const copy = makeCopy();

    const result = await pairDeliveryWithConversation(
      signal,
      "telegram" as NotificationChannel,
      copy,
    );

    // Currently creates a new conversation even for continue_existing_conversation
    // (true continuation is planned for a future PR)
    expect(result.conversationId).toBe("conv-001");
    expect(result.messageId).toBe("msg-001");
    expect(result.strategy).toBe("continue_existing_conversation");
    expect(result.createdNewConversation).toBe(true);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    const callArgs = createConversationMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(callArgs.threadType).toBe("background");
  });

  // ── not_deliverable (voice) ───────────────────────────────────────

  test("returns null conversationId and messageId for not_deliverable strategy", async () => {
    const signal = makeSignal();
    const copy = makeCopy();

    // voice has not_deliverable strategy — need to cast since voice is
    // not a NotificationChannel (deliveryEnabled: false), but the function
    // accepts NotificationChannel which is then cast internally to ChannelId.
    const result = await pairDeliveryWithConversation(
      signal,
      "voice" as NotificationChannel,
      copy,
    );

    expect(result.conversationId).toBeNull();
    expect(result.messageId).toBeNull();
    expect(result.strategy).toBe("not_deliverable");
    expect(result.createdNewConversation).toBe(false);
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(addMessageMock).not.toHaveBeenCalled();
  });

  // ── Thread reuse (reuse_existing) ─────────────────────────────────

  test("reuses existing conversation when threadAction is reuse_existing and target is valid", async () => {
    mockExistingConversations["conv-existing"] = {
      id: "conv-existing",
      source: "notification",
      title: "Previous Thread",
    };

    const signal = makeSignal();
    const copy = makeCopy({
      threadSeedMessage: "Follow-up notification message content",
    });
    const threadAction: ThreadAction = {
      action: "reuse_existing",
      conversationId: "conv-existing",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
      { threadAction },
    );

    expect(result.conversationId).toBe("conv-existing");
    expect(result.messageId).toBe("msg-001");
    expect(result.createdNewConversation).toBe(false);
    expect(result.threadDecisionFallbackUsed).toBe(false);
    // Should NOT have created a new conversation — only addMessage should be called
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    // Verify addMessage was called with the existing conversation ID
    expect(addMessageMock.mock.calls[0]![0]).toBe("conv-existing");
  });

  test("falls back to new conversation when reuse target does not exist", async () => {
    // No existing conversations — target is stale/invalid
    const signal = makeSignal();
    const copy = makeCopy();
    const threadAction: ThreadAction = {
      action: "reuse_existing",
      conversationId: "conv-nonexistent",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
      { threadAction },
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.messageId).toBe("msg-001");
    expect(result.createdNewConversation).toBe(true);
    expect(result.threadDecisionFallbackUsed).toBe(true);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
  });

  test("falls back to new conversation when reuse target has wrong source", async () => {
    // Conversation exists but was created by user, not notification
    mockExistingConversations["conv-user"] = {
      id: "conv-user",
      source: "user",
      title: "User Thread",
    };

    const signal = makeSignal();
    const copy = makeCopy();
    const threadAction: ThreadAction = {
      action: "reuse_existing",
      conversationId: "conv-user",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
      { threadAction },
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.createdNewConversation).toBe(true);
    expect(result.threadDecisionFallbackUsed).toBe(true);
  });

  test("creates new conversation when threadAction is start_new", async () => {
    const signal = makeSignal();
    const copy = makeCopy();
    const threadAction: ThreadAction = { action: "start_new" };

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
      { threadAction },
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.createdNewConversation).toBe(true);
    expect(result.threadDecisionFallbackUsed).toBe(false);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
  });

  test("creates new conversation when threadAction is undefined (default)", async () => {
    const signal = makeSignal();
    const copy = makeCopy();

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.createdNewConversation).toBe(true);
    expect(result.threadDecisionFallbackUsed).toBe(false);
  });

  // ── Error resilience ──────────────────────────────────────────────

  test("catches createConversation errors and returns null IDs without throwing", async () => {
    createConversationShouldThrow = true;
    const signal = makeSignal();
    const copy = makeCopy();

    // Should not throw
    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
    );

    expect(result.conversationId).toBeNull();
    expect(result.messageId).toBeNull();
    // Strategy should still be resolved from the policy registry
    expect(result.strategy).toBe("start_new_conversation");
    expect(result.createdNewConversation).toBe(false);
  });

  test("catches addMessage errors and returns null IDs without throwing", async () => {
    addMessageShouldThrow = true;
    const signal = makeSignal();
    const copy = makeCopy();

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
    );

    expect(result.conversationId).toBeNull();
    expect(result.messageId).toBeNull();
    expect(result.strategy).toBe("start_new_conversation");
  });

  test("error in pairing does not break the pipeline (no throw)", async () => {
    createConversationShouldThrow = true;

    // Calling multiple times should all succeed without throwing
    for (let i = 0; i < 3; i++) {
      const result = await pairDeliveryWithConversation(
        makeSignal({ signalId: `sig-${i}` }),
        "vellum" as NotificationChannel,
        makeCopy(),
      );
      expect(result.conversationId).toBeNull();
    }
  });
});
