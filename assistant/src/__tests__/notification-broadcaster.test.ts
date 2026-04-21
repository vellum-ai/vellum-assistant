/**
 * Regression tests for the notification broadcaster.
 *
 * Validates that the broadcaster correctly:
 * - Dispatches to registered adapters
 * - Handles missing adapters gracefully
 * - Falls back to copy-composer when decision copy is missing
 * - Reports delivery results per channel
 * - Emits notification_conversation_created only when a new conversation is created
 * - Does NOT emit notification_conversation_created when reusing an existing conversation
 * - Passes destination binding context into conversation pairing for external channels
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

import type { PairingOptions } from "../notifications/conversation-pairing.js";

// -- Mocks (must be declared before importing modules that depend on them) ----

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock destination-resolver to return a destination for every requested channel.
// External channels (telegram, slack) include bindingContext.
mock.module("../notifications/destination-resolver.js", () => ({
  resolveDestinations: (channels: string[]) => {
    const m = new Map();
    for (const ch of channels) {
      const isExternal = ch === "telegram" || ch === "slack";
      m.set(ch, {
        channel: ch,
        endpoint: `mock-${ch}`,
        ...(isExternal
          ? {
              bindingContext: {
                sourceChannel: ch,
                externalChatId: `ext-chat-${ch}`,
                externalUserId: `ext-user-${ch}`,
              },
            }
          : {}),
      });
    }
    return m;
  },
}));

// Mock deliveries-store to avoid DB access
mock.module("../notifications/deliveries-store.js", () => ({
  createDelivery: () => {},
  updateDeliveryStatus: () => {},
}));

// Configurable mock for conversation-pairing.
// Captures call arguments so tests can inspect what was passed in.
// Set `nextPairingResult` to override the return value for a single call.
let nextPairingResult:
  | import("../notifications/conversation-pairing.js").PairingResult
  | null = null;
let pairingCallCount = 0;

interface PairingCall {
  channel: string;
  options?: PairingOptions;
}
const pairingCalls: PairingCall[] = [];

mock.module("../notifications/conversation-pairing.js", () => ({
  pairDeliveryWithConversation: async (
    _signal: unknown,
    channel: string,
    _copy: unknown,
    options?: PairingOptions,
  ) => {
    pairingCalls.push({ channel, options });
    if (nextPairingResult) {
      const result = nextPairingResult;
      nextPairingResult = null;
      return result;
    }
    // Default: simulate creating a new conversation with a unique ID
    const id = `mock-conv-${++pairingCallCount}`;
    return {
      conversationId: id,
      messageId: `mock-msg-${pairingCallCount}`,
      strategy: "start_new_conversation" as const,
      createdNewConversation: true,
      conversationFallbackUsed: false,
    };
  },
}));

import type { ConversationCreatedInfo } from "../notifications/broadcaster.js";
import { NotificationBroadcaster } from "../notifications/broadcaster.js";
import type { NotificationSignal } from "../notifications/signal.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  DeliveryResult,
  NotificationChannel,
  NotificationDecision,
} from "../notifications/types.js";

// -- Helpers -----------------------------------------------------------------

function makeSignal(
  overrides?: Partial<NotificationSignal>,
): NotificationSignal {
  return {
    signalId: "sig-broadcast-001",
    createdAt: Date.now(),
    sourceChannel: "scheduler",
    sourceContextId: "sess-001",
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

function makeDecision(
  overrides?: Partial<NotificationDecision>,
): NotificationDecision {
  return {
    shouldNotify: true,
    selectedChannels: ["vellum"],
    reasoningSummary: "Test decision",
    renderedCopy: {
      vellum: { title: "Test Alert", body: "Something happened" },
    },
    dedupeKey: "broadcast-test-001",
    confidence: 0.9,
    fallbackUsed: false,
    ...overrides,
  };
}

class MockAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel;
  sent: ChannelDeliveryPayload[] = [];
  shouldFail = false;

  constructor(channel: NotificationChannel) {
    this.channel = channel;
  }

  async send(
    payload: ChannelDeliveryPayload,
    _dest: ChannelDestination,
  ): Promise<DeliveryResult> {
    this.sent.push(payload);
    if (this.shouldFail) return { success: false, error: "Mock failure" };
    return { success: true };
  }
}

// -- Tests -------------------------------------------------------------------

describe("notification broadcaster", () => {
  beforeEach(() => {
    pairingCalls.length = 0;
    nextPairingResult = null;
  });
  test("dispatches to the vellum adapter when selected", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision();

    const results = await broadcaster.broadcastDecision(signal, decision);

    expect(vellumAdapter.sent).toHaveLength(1);
    expect(vellumAdapter.sent[0].copy.title).toBe("Test Alert");
    expect(
      results.some((r) => r.channel === "vellum" && r.status === "sent"),
    ).toBe(true);
  });

  test("skips channels without registered adapters", async () => {
    // Register only vellum, but decision selects both
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision({
      selectedChannels: ["vellum", "telegram"],
      renderedCopy: {
        vellum: { title: "Test", body: "Body" },
        telegram: { title: "Test", body: "Body" },
      },
    });

    const results = await broadcaster.broadcastDecision(signal, decision);

    // Vellum should succeed, telegram should be skipped (no adapter registered)
    expect(results).toHaveLength(2);
    const vellumResult = results.find((r) => r.channel === "vellum");
    const telegramResult = results.find((r) => r.channel === "telegram");
    expect(vellumResult?.status).toBe("sent");
    expect(telegramResult?.status).toBe("skipped");
  });

  test("reports failed delivery when adapter returns error", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    vellumAdapter.shouldFail = true;
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision();

    const results = await broadcaster.broadcastDecision(signal, decision);

    expect(results).toHaveLength(1);
    expect(results[0].status).toBe("failed");
    expect(results[0].errorMessage).toContain("Mock failure");
  });

  test("passes deepLinkTarget through to adapter payload", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision({
      deepLinkTarget: { conversationId: "conv-123", screen: "thread" },
    });

    await broadcaster.broadcastDecision(signal, decision);

    expect(vellumAdapter.sent).toHaveLength(1);
    // The broadcaster overwrites deepLinkTarget.conversationId with the
    // paired conversation ID, so the original 'conv-123' is replaced.
    // Verify the structure is correct and that conversationId comes from
    // the pairing result, not the pre-pairing placeholder.
    const deepLink = vellumAdapter.sent[0].deepLinkTarget;
    expect(deepLink).toBeDefined();
    expect(deepLink!.screen).toBe("thread");
    expect(deepLink!.conversationId).toBeDefined();
    expect(deepLink!.conversationId).not.toBe("conv-123");
    // Should be the paired conversation ID from conversation-pairing
    expect(deepLink!.conversationId).toMatch(/^mock-conv-\d+$/);
  });

  test("multiple channels receive independent copy from the decision", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const telegramAdapter = new MockAdapter("telegram");
    const broadcaster = new NotificationBroadcaster([
      vellumAdapter,
      telegramAdapter,
    ]);

    const signal = makeSignal();
    const decision = makeDecision({
      selectedChannels: ["vellum", "telegram"],
      renderedCopy: {
        vellum: { title: "Desktop Alert", body: "For desktop" },
        telegram: { title: "Mobile Alert", body: "For mobile" },
      },
    });

    await broadcaster.broadcastDecision(signal, decision);

    expect(vellumAdapter.sent).toHaveLength(1);
    expect(vellumAdapter.sent[0].copy.title).toBe("Desktop Alert");

    expect(telegramAdapter.sent).toHaveLength(1);
    expect(telegramAdapter.sent[0].copy.title).toBe("Mobile Alert");
  });

  test("uses fallback copy when decision is missing copy for a channel", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal({ sourceEventName: "schedule.notify" });
    const decision = makeDecision({
      renderedCopy: {}, // No rendered copy
      fallbackUsed: true,
    });

    await broadcaster.broadcastDecision(signal, decision);

    expect(vellumAdapter.sent).toHaveLength(1);
    // The fallback should produce some copy (either from template or generic)
    expect(vellumAdapter.sent[0].copy.title).toBeDefined();
    expect(vellumAdapter.sent[0].copy.body).toBeDefined();
  });

  test("adapter receives concise copy (title/body), not the conversation seed message", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "Reminder",
          body: "Take out the trash",
          conversationSeedMessage:
            "This is a much richer seed message with more context about the reminder and what you should do about it.",
        },
      },
    });

    await broadcaster.broadcastDecision(signal, decision);

    expect(vellumAdapter.sent).toHaveLength(1);
    // The adapter payload uses the full copy object — title/body are what
    // the native notification displays. The conversationSeedMessage is only consumed
    // by conversation pairing, not by the adapter's display logic.
    expect(vellumAdapter.sent[0].copy.title).toBe("Reminder");
    expect(vellumAdapter.sent[0].copy.body).toBe("Take out the trash");
  });

  test("empty selectedChannels produces no deliveries", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision({
      selectedChannels: [],
    });

    const results = await broadcaster.broadcastDecision(signal, decision);

    expect(results).toHaveLength(0);
    expect(vellumAdapter.sent).toHaveLength(0);
  });

  // ── Conversation-created event emission ─────────────────────────────

  test("fires onConversationCreated when a new vellum conversation is created (start_new)", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);
    const conversationCreatedCalls: ConversationCreatedInfo[] = [];
    broadcaster.setOnConversationCreated((info) =>
      conversationCreatedCalls.push(info),
    );

    const signal = makeSignal();
    // No conversationActions means default start_new behavior
    const decision = makeDecision();

    await broadcaster.broadcastDecision(signal, decision);

    // Pairing creates a new conversation by default, so onConversationCreated should fire
    expect(conversationCreatedCalls).toHaveLength(1);
    expect(conversationCreatedCalls[0].sourceEventName).toBe("test.event");
  });

  test("fires per-dispatch onConversationCreated callback on new conversation", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);
    const dispatchCalls: ConversationCreatedInfo[] = [];

    const signal = makeSignal();
    const decision = makeDecision();

    await broadcaster.broadcastDecision(signal, decision, {
      onConversationCreated: (info) => dispatchCalls.push(info),
    });

    expect(dispatchCalls).toHaveLength(1);
  });

  test("does NOT fire class-level onConversationCreated when reusing an existing conversation", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);
    const eventCalls: ConversationCreatedInfo[] = [];
    const dispatchCalls: ConversationCreatedInfo[] = [];
    broadcaster.setOnConversationCreated((info) => eventCalls.push(info));

    // Simulate a successful reuse by injecting a pairing result with
    // createdNewConversation=false. This bypasses the real conversation
    // store (which would fall back to creating a new conversation since
    // the target does not exist in the test DB).
    nextPairingResult = {
      conversationId: "conv-reused-456",
      messageId: "msg-reused-789",
      strategy: "start_new_conversation",
      createdNewConversation: false,
      conversationFallbackUsed: false,
    };

    const signal = makeSignal();
    const decision = makeDecision({
      conversationActions: {
        vellum: {
          action: "reuse_existing",
          conversationId: "conv-existing-123",
        },
      },
    });

    await broadcaster.broadcastDecision(signal, decision, {
      onConversationCreated: (info) => dispatchCalls.push(info),
    });

    // The class-level event callback should NOT fire because
    // createdNewConversation is false — the client already knows about
    // the reused conversation.
    expect(eventCalls).toHaveLength(0);

    // The per-dispatch callback SHOULD fire for both new and reused
    // pairings (used by callers like dispatchGuardianQuestion for
    // delivery bookkeeping).
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].conversationId).toBe("conv-reused-456");
  });

  // ── Destination binding context ────────────────────────────────────

  test("Telegram delivery carries destination binding context into pairing (additional)", async () => {
    const telegramAdapter2 = new MockAdapter("telegram");
    const broadcaster = new NotificationBroadcaster([telegramAdapter2]);

    const signal = makeSignal();
    const decision = makeDecision({
      selectedChannels: ["telegram"],
      renderedCopy: {
        telegram: { title: "Telegram Alert", body: "Something happened" },
      },
    });

    await broadcaster.broadcastDecision(signal, decision);

    const telegramCall = pairingCalls.find((c) => c.channel === "telegram");
    expect(telegramCall).toBeDefined();
    expect(telegramCall!.options?.bindingContext).toEqual({
      sourceChannel: "telegram",
      externalChatId: "ext-chat-telegram",
      externalUserId: "ext-user-telegram",
    });
  });

  test("Telegram delivery carries destination binding context into pairing", async () => {
    const telegramAdapter = new MockAdapter("telegram");
    const broadcaster = new NotificationBroadcaster([telegramAdapter]);

    const signal = makeSignal();
    const decision = makeDecision({
      selectedChannels: ["telegram"],
      renderedCopy: {
        telegram: { title: "Telegram Alert", body: "Something happened" },
      },
    });

    await broadcaster.broadcastDecision(signal, decision);

    const telegramCall = pairingCalls.find((c) => c.channel === "telegram");
    expect(telegramCall).toBeDefined();
    expect(telegramCall!.options?.bindingContext).toEqual({
      sourceChannel: "telegram",
      externalChatId: "ext-chat-telegram",
      externalUserId: "ext-user-telegram",
    });
  });

  test("Slack delivery carries destination binding context into pairing", async () => {
    const slackAdapter = new MockAdapter("slack");
    const broadcaster = new NotificationBroadcaster([slackAdapter]);

    const signal = makeSignal();
    const decision = makeDecision({
      selectedChannels: ["slack"],
      renderedCopy: {
        slack: { title: "Slack Alert", body: "Something happened" },
      },
    });

    await broadcaster.broadcastDecision(signal, decision);

    const slackCall = pairingCalls.find((c) => c.channel === "slack");
    expect(slackCall).toBeDefined();
    expect(slackCall!.options?.bindingContext).toEqual({
      sourceChannel: "slack",
      externalChatId: "ext-chat-slack",
      externalUserId: "ext-user-slack",
    });
  });

  test("reused conversation via binding-key continuation does NOT emit class-level onConversationCreated", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);
    const eventCalls: ConversationCreatedInfo[] = [];
    broadcaster.setOnConversationCreated((info) => eventCalls.push(info));

    // Simulate binding-key continuation: pairing reuses an existing bound
    // conversation (createdNewConversation=false, strategy=continue_existing_conversation)
    nextPairingResult = {
      conversationId: "conv-bound-voice-001",
      messageId: "msg-bound-voice-001",
      strategy: "continue_existing_conversation" as const,
      createdNewConversation: false,
      conversationFallbackUsed: false,
    };

    const signal = makeSignal();
    const decision = makeDecision();

    await broadcaster.broadcastDecision(signal, decision);

    // The class-level event callback should NOT fire because
    // createdNewConversation is false — the conversation already exists
    // in the external channel and the client already knows about it.
    expect(eventCalls).toHaveLength(0);
  });

  test("fresh conversation for continue_existing_conversation does NOT emit class-level onConversationCreated", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);
    const eventCalls: ConversationCreatedInfo[] = [];
    broadcaster.setOnConversationCreated((info) => eventCalls.push(info));

    // First delivery to a new destination: creates a fresh conversation but
    // the strategy is continue_existing_conversation (not start_new_conversation),
    // so the event should NOT fire — these are background conversations not
    // meant to appear in the sidebar.
    nextPairingResult = {
      conversationId: "conv-new-telegram-dest",
      messageId: "msg-new-telegram-dest",
      strategy: "continue_existing_conversation" as const,
      createdNewConversation: true,
      conversationFallbackUsed: false,
    };

    const signal = makeSignal();
    const decision = makeDecision();

    await broadcaster.broadcastDecision(signal, decision);

    // Even though createdNewConversation is true, the strategy is
    // continue_existing_conversation, so the event gate rejects it.
    expect(eventCalls).toHaveLength(0);
  });

  test("per-dispatch onConversationCreated fires for reused binding-key conversation", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);
    const dispatchCalls: ConversationCreatedInfo[] = [];

    // Binding-key reuse: conversation already exists
    nextPairingResult = {
      conversationId: "conv-bound-telegram-456",
      messageId: "msg-bound-telegram-789",
      strategy: "continue_existing_conversation" as const,
      createdNewConversation: false,
      conversationFallbackUsed: false,
    };

    const signal = makeSignal();
    const decision = makeDecision();

    await broadcaster.broadcastDecision(signal, decision, {
      onConversationCreated: (info) => dispatchCalls.push(info),
    });

    // The per-dispatch callback SHOULD fire regardless of reuse
    // (callers like dispatchGuardianQuestion need it for bookkeeping)
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].conversationId).toBe("conv-bound-telegram-456");
  });

  test("vellum delivery does NOT carry binding context into pairing", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision();

    await broadcaster.broadcastDecision(signal, decision);

    const vellumCall = pairingCalls.find((c) => c.channel === "vellum");
    expect(vellumCall).toBeDefined();
    expect(vellumCall!.options?.bindingContext).toBeUndefined();
  });

  // ── conversationMetadata propagation ──────────────────────────────

  test("onConversationCreated includes groupId and source from conversationMetadata", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);
    const createdCalls: ConversationCreatedInfo[] = [];
    broadcaster.setOnConversationCreated((info) => createdCalls.push(info));

    const signal = makeSignal({
      sourceEventName: "schedule.notify",
      conversationMetadata: {
        groupId: "system:scheduled",
        source: "schedule",
        scheduleJobId: "job-abc-123",
      },
    });
    const decision = makeDecision();

    await broadcaster.broadcastDecision(signal, decision);

    expect(createdCalls).toHaveLength(1);
    expect(createdCalls[0].groupId).toBe("system:scheduled");
    expect(createdCalls[0].source).toBe("schedule");
    expect(createdCalls[0].sourceEventName).toBe("schedule.notify");
  });

  test("onConversationCreated omits groupId and source when conversationMetadata is absent", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);
    const createdCalls: ConversationCreatedInfo[] = [];
    broadcaster.setOnConversationCreated((info) => createdCalls.push(info));

    const signal = makeSignal(); // no conversationMetadata
    const decision = makeDecision();

    await broadcaster.broadcastDecision(signal, decision);

    expect(createdCalls).toHaveLength(1);
    expect(createdCalls[0].groupId).toBeUndefined();
    expect(createdCalls[0].source).toBeUndefined();
  });

  test("per-dispatch callback receives conversationMetadata fields", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);
    const dispatchCalls: ConversationCreatedInfo[] = [];

    const signal = makeSignal({
      sourceEventName: "schedule.notify",
      conversationMetadata: {
        groupId: "system:scheduled",
        source: "schedule",
      },
    });
    const decision = makeDecision();

    await broadcaster.broadcastDecision(signal, decision, {
      onConversationCreated: (info) => dispatchCalls.push(info),
    });

    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].groupId).toBe("system:scheduled");
    expect(dispatchCalls[0].source).toBe("schedule");
  });
});
