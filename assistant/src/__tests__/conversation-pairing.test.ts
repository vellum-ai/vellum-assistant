/**
 * Regression tests for notification conversation pairing.
 *
 * Validates that pairDeliveryWithConversation materializes conversations
 * and messages according to the channel's conversation strategy, handles
 * conversation reuse decisions, binding-key reuse for continue_existing channels,
 * and that errors in pairing never break the notification pipeline.
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

mock.module("../memory/conversation-crud.js", () => ({
  getConversationType: () => "default",
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

/** Simulated bindings for external-conversation-store mock. */
let mockBindings: Record<
  string,
  { conversationId: string; sourceChannel: string; externalChatId: string }
> = {};

const getBindingByChannelChatMock = mock(
  (sourceChannel: string, externalChatId: string) => {
    const key = `${sourceChannel}:${externalChatId}`;
    return mockBindings[key] ?? null;
  },
);

const upsertOutboundBindingMock = mock(
  (_input: {
    conversationId: string;
    sourceChannel: string;
    externalChatId: string;
  }) => {},
);

mock.module("../memory/external-conversation-store.js", () => ({
  getBindingByChannelChat: getBindingByChannelChatMock,
  upsertOutboundBinding: upsertOutboundBindingMock,
}));

import { pairDeliveryWithConversation } from "../notifications/conversation-pairing.js";
import type { NotificationSignal } from "../notifications/signal.js";
import type {
  ConversationAction,
  DestinationBindingContext,
  NotificationChannel,
  RenderedChannelCopy,
} from "../notifications/types.js";

// ── Test helpers ────────────────────────────────────────────────────────

function makeSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: "sig-test",
    createdAt: Date.now(),
    sourceChannel: "scheduler",
    sourceConversationId: "sess-1",
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
    getBindingByChannelChatMock.mockClear();
    upsertOutboundBindingMock.mockClear();
    mockConversationId = "conv-001";
    mockMessageId = "msg-001";
    createConversationShouldThrow = false;
    addMessageShouldThrow = false;
    mockExistingConversations = {};
    mockBindings = {};
  });

  // ── start_new_conversation (vellum) ─────────────────────────────────

  test("creates a conversation and message for start_new_conversation strategy", async () => {
    const signal = makeSignal();
    const copy = makeCopy({ conversationTitle: "Alert Thread" });

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.messageId).toBe("msg-001");
    expect(result.strategy).toBe("start_new_conversation");
    expect(result.createdNewConversation).toBe(true);
    expect(result.conversationFallbackUsed).toBe(false);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    const callArgs = createConversationMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(callArgs.conversationType).toBe("standard");
  });

  test("uses conversationTitle for conversation title when available", async () => {
    const signal = makeSignal();
    const copy = makeCopy({ conversationTitle: "Custom Thread Title" });

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

  test("falls back to copy title when conversationTitle is absent", async () => {
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

  test("uses conversationSeedMessage for message content when present and sane", async () => {
    const signal = makeSignal();
    const copy = makeCopy({
      conversationSeedMessage: "Custom seed message with enough length",
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

  test("rejects conversationSeedMessage that is a JSON dump and uses runtime composer", async () => {
    const signal = makeSignal({
      sourceEventName: "schedule.notify",
      contextPayload: { message: "Daily standup" },
    });
    const copy = makeCopy({
      title: "Reminder",
      body: "Daily standup",
      conversationSeedMessage: '{"raw": "json dump payload"}',
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

  test("rejects very short conversationSeedMessage and uses runtime composer", async () => {
    const signal = makeSignal({
      sourceEventName: "schedule.notify",
      contextPayload: { message: "Test" },
    });
    const copy = makeCopy({
      title: "Reminder",
      body: "Test reminder",
      conversationSeedMessage: "Hi",
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

  test("creates a conversation for continue_existing_conversation without binding context", async () => {
    const signal = makeSignal();
    const copy = makeCopy();

    const result = await pairDeliveryWithConversation(
      signal,
      "telegram" as NotificationChannel,
      copy,
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.messageId).toBe("msg-001");
    expect(result.strategy).toBe("continue_existing_conversation");
    expect(result.createdNewConversation).toBe(true);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    const callArgs = createConversationMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(callArgs.conversationType).toBe("background");
  });

  // ── Binding-key reuse (continue_existing + bindingContext) ────────

  test("reuses bound conversation when binding context matches an existing notification conversation", async () => {
    mockExistingConversations["conv-bound"] = {
      id: "conv-bound",
      source: "notification",
      title: "Telegram Thread",
    };
    mockBindings["notification:telegram:chat-123"] = {
      conversationId: "conv-bound",
      sourceChannel: "notification:telegram",
      externalChatId: "chat-123",
    };

    const signal = makeSignal();
    const copy = makeCopy({
      conversationSeedMessage: "Second notification to same chat",
    });
    const bindingContext: DestinationBindingContext = {
      sourceChannel: "telegram" as NotificationChannel,
      externalChatId: "chat-123",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "telegram" as NotificationChannel,
      copy,
      { bindingContext },
    );

    expect(result.conversationId).toBe("conv-bound");
    expect(result.messageId).toBe("msg-001");
    expect(result.createdNewConversation).toBe(false);
    expect(result.conversationFallbackUsed).toBe(false);
    expect(result.strategy).toBe("continue_existing_conversation");
    // Should append to existing, not create new
    expect(createConversationMock).not.toHaveBeenCalled();
    expect(addMessageMock).toHaveBeenCalledTimes(1);
    expect(addMessageMock.mock.calls[0]![0]).toBe("conv-bound");
    // Should touch the outbound binding
    expect(upsertOutboundBindingMock).toHaveBeenCalledTimes(1);
  });

  test("reuses pre-namespace binding when namespaced binding is absent", async () => {
    // Simulate a binding created before the notification: prefix was introduced
    mockExistingConversations["conv-legacy"] = {
      id: "conv-legacy",
      source: "notification",
      title: "Legacy Telegram Thread",
    };
    mockBindings["telegram:chat-legacy"] = {
      conversationId: "conv-legacy",
      sourceChannel: "telegram",
      externalChatId: "chat-legacy",
    };

    const signal = makeSignal();
    const copy = makeCopy({
      conversationSeedMessage: "Delivery to legacy binding",
    });
    const bindingContext: DestinationBindingContext = {
      sourceChannel: "telegram" as NotificationChannel,
      externalChatId: "chat-legacy",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "telegram" as NotificationChannel,
      copy,
      { bindingContext },
    );

    expect(result.conversationId).toBe("conv-legacy");
    expect(result.createdNewConversation).toBe(false);
    expect(createConversationMock).not.toHaveBeenCalled();
    // The upsert should write with the new namespaced sourceChannel
    expect(upsertOutboundBindingMock).toHaveBeenCalledTimes(1);
    const upsertArgs = upsertOutboundBindingMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(upsertArgs.sourceChannel).toBe("notification:telegram");
  });

  test("falls back to new conversation when bound conversation is stale (wrong source)", async () => {
    mockExistingConversations["conv-user-owned"] = {
      id: "conv-user-owned",
      source: "user",
      title: "User Thread",
    };
    mockBindings["notification:slack:C0123ABCDEF"] = {
      conversationId: "conv-user-owned",
      sourceChannel: "notification:slack",
      externalChatId: "C0123ABCDEF",
    };

    const signal = makeSignal();
    const copy = makeCopy();
    const bindingContext: DestinationBindingContext = {
      sourceChannel: "slack" as NotificationChannel,
      externalChatId: "C0123ABCDEF",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "slack" as NotificationChannel,
      copy,
      { bindingContext },
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.createdNewConversation).toBe(true);
    expect(result.conversationFallbackUsed).toBe(false);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    // Should upsert the binding for the new conversation
    expect(upsertOutboundBindingMock).toHaveBeenCalledTimes(1);
    const upsertArgs = upsertOutboundBindingMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(upsertArgs.conversationId).toBe("conv-001");
    expect(upsertArgs.sourceChannel).toBe("notification:slack");
  });

  test("falls back to new conversation when bound conversation no longer exists", async () => {
    // Binding exists but conversation was deleted
    mockBindings["notification:telegram:chat-456"] = {
      conversationId: "conv-deleted",
      sourceChannel: "notification:telegram",
      externalChatId: "chat-456",
    };

    const signal = makeSignal();
    const copy = makeCopy();
    const bindingContext: DestinationBindingContext = {
      sourceChannel: "telegram" as NotificationChannel,
      externalChatId: "chat-456",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "telegram" as NotificationChannel,
      copy,
      { bindingContext },
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.createdNewConversation).toBe(true);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    // Should upsert the new conversation binding
    expect(upsertOutboundBindingMock).toHaveBeenCalledTimes(1);
  });

  test("creates new conversation and upserts binding when no prior binding exists", async () => {
    const signal = makeSignal();
    const copy = makeCopy();
    const bindingContext: DestinationBindingContext = {
      sourceChannel: "slack" as NotificationChannel,
      externalChatId: "C0123ABCDEF",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "slack" as NotificationChannel,
      copy,
      { bindingContext },
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.createdNewConversation).toBe(true);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    // Should upsert so future deliveries reuse this conversation
    expect(upsertOutboundBindingMock).toHaveBeenCalledTimes(1);
    const upsertArgs = upsertOutboundBindingMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(upsertArgs.conversationId).toBe("conv-001");
    expect(upsertArgs.sourceChannel).toBe("notification:slack");
    expect(upsertArgs.externalChatId).toBe("C0123ABCDEF");
  });

  test("reuse_existing rebinds destination when binding context is present", async () => {
    mockExistingConversations["conv-explicit"] = {
      id: "conv-explicit",
      source: "notification",
      title: "Explicit Thread",
    };

    const signal = makeSignal();
    const copy = makeCopy({
      conversationSeedMessage: "Follow-up to explicit reuse target",
    });
    const conversationAction: ConversationAction = {
      action: "reuse_existing",
      conversationId: "conv-explicit",
    };
    const bindingContext: DestinationBindingContext = {
      sourceChannel: "telegram" as NotificationChannel,
      externalChatId: "chat-rebind",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "telegram" as NotificationChannel,
      copy,
      { conversationAction, bindingContext },
    );

    expect(result.conversationId).toBe("conv-explicit");
    expect(result.createdNewConversation).toBe(false);
    // Should rebind the destination to the reused conversation
    expect(upsertOutboundBindingMock).toHaveBeenCalledTimes(1);
    const upsertArgs = upsertOutboundBindingMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(upsertArgs.conversationId).toBe("conv-explicit");
    expect(upsertArgs.sourceChannel).toBe("notification:telegram");
    expect(upsertArgs.externalChatId).toBe("chat-rebind");
  });

  test("reuse_existing fallback rebinds destination when binding context is present", async () => {
    // Target does not exist — falls back to new conversation
    const signal = makeSignal();
    const copy = makeCopy();
    const conversationAction: ConversationAction = {
      action: "reuse_existing",
      conversationId: "conv-gone",
    };
    const bindingContext: DestinationBindingContext = {
      sourceChannel: "slack" as NotificationChannel,
      externalChatId: "C9876ZYXWVU",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "slack" as NotificationChannel,
      copy,
      { conversationAction, bindingContext },
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.createdNewConversation).toBe(true);
    expect(result.conversationFallbackUsed).toBe(true);
    // Should bind the new conversation to the destination
    expect(upsertOutboundBindingMock).toHaveBeenCalledTimes(1);
    const upsertArgs = upsertOutboundBindingMock.mock.calls[0]![0] as Record<
      string,
      unknown
    >;
    expect(upsertArgs.conversationId).toBe("conv-001");
    expect(upsertArgs.sourceChannel).toBe("notification:slack");
    expect(upsertArgs.externalChatId).toBe("C9876ZYXWVU");
  });

  test("explicit reuse_existing takes precedence over binding-key reuse", async () => {
    // Both a binding and a reuse_existing target exist — reuse_existing wins
    mockExistingConversations["conv-explicit"] = {
      id: "conv-explicit",
      source: "notification",
      title: "Explicit Thread",
    };
    mockExistingConversations["conv-bound"] = {
      id: "conv-bound",
      source: "notification",
      title: "Bound Thread",
    };
    mockBindings["notification:telegram:chat-789"] = {
      conversationId: "conv-bound",
      sourceChannel: "notification:telegram",
      externalChatId: "chat-789",
    };

    const signal = makeSignal();
    const copy = makeCopy({
      conversationSeedMessage: "Message for explicit reuse target",
    });
    const conversationAction: ConversationAction = {
      action: "reuse_existing",
      conversationId: "conv-explicit",
    };
    const bindingContext: DestinationBindingContext = {
      sourceChannel: "telegram" as NotificationChannel,
      externalChatId: "chat-789",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "telegram" as NotificationChannel,
      copy,
      { conversationAction, bindingContext },
    );

    // Should use the explicit target, not the binding
    expect(result.conversationId).toBe("conv-explicit");
    expect(result.createdNewConversation).toBe(false);
    expect(createConversationMock).not.toHaveBeenCalled();
    // Binding lookup should not even be attempted since reuse_existing matched first
    expect(getBindingByChannelChatMock).not.toHaveBeenCalled();
  });

  test("binding context does not trigger reuse for start_new_conversation channels", async () => {
    // vellum uses start_new_conversation — binding context should be ignored for reuse
    mockExistingConversations["conv-bound-vellum"] = {
      id: "conv-bound-vellum",
      source: "notification",
      title: "Vellum Thread",
    };
    mockBindings["notification:vellum:device-1"] = {
      conversationId: "conv-bound-vellum",
      sourceChannel: "notification:vellum",
      externalChatId: "device-1",
    };

    const signal = makeSignal();
    const copy = makeCopy();
    const bindingContext: DestinationBindingContext = {
      sourceChannel: "vellum" as NotificationChannel,
      externalChatId: "device-1",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
      { bindingContext },
    );

    // Should still create a new conversation — vellum is start_new_conversation
    expect(result.conversationId).toBe("conv-001");
    expect(result.createdNewConversation).toBe(true);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
    // Binding lookup should not be called for non-continue_existing channels
    expect(getBindingByChannelChatMock).not.toHaveBeenCalled();
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
      "phone" as NotificationChannel,
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

  test("reuses existing conversation when conversationAction is reuse_existing and target is valid", async () => {
    mockExistingConversations["conv-existing"] = {
      id: "conv-existing",
      source: "notification",
      title: "Previous Thread",
    };

    const signal = makeSignal();
    const copy = makeCopy({
      conversationSeedMessage: "Follow-up notification message content",
    });
    const conversationAction: ConversationAction = {
      action: "reuse_existing",
      conversationId: "conv-existing",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
      { conversationAction },
    );

    expect(result.conversationId).toBe("conv-existing");
    expect(result.messageId).toBe("msg-001");
    expect(result.createdNewConversation).toBe(false);
    expect(result.conversationFallbackUsed).toBe(false);
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
    const conversationAction: ConversationAction = {
      action: "reuse_existing",
      conversationId: "conv-nonexistent",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
      { conversationAction },
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.messageId).toBe("msg-001");
    expect(result.createdNewConversation).toBe(true);
    expect(result.conversationFallbackUsed).toBe(true);
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
    const conversationAction: ConversationAction = {
      action: "reuse_existing",
      conversationId: "conv-user",
    };

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
      { conversationAction },
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.createdNewConversation).toBe(true);
    expect(result.conversationFallbackUsed).toBe(true);
  });

  test("creates new conversation when conversationAction is start_new", async () => {
    const signal = makeSignal();
    const copy = makeCopy();
    const conversationAction: ConversationAction = { action: "start_new" };

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
      { conversationAction },
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.createdNewConversation).toBe(true);
    expect(result.conversationFallbackUsed).toBe(false);
    expect(createConversationMock).toHaveBeenCalledTimes(1);
  });

  test("creates new conversation when conversationAction is undefined (default)", async () => {
    const signal = makeSignal();
    const copy = makeCopy();

    const result = await pairDeliveryWithConversation(
      signal,
      "vellum" as NotificationChannel,
      copy,
    );

    expect(result.conversationId).toBe("conv-001");
    expect(result.createdNewConversation).toBe(true);
    expect(result.conversationFallbackUsed).toBe(false);
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
