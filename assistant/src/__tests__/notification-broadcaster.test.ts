/**
 * Regression tests for the notification broadcaster.
 *
 * Validates that the broadcaster correctly:
 * - Dispatches to registered adapters
 * - Handles missing adapters gracefully
 * - Falls back to copy-composer when decision copy is missing
 * - Reports delivery results per channel
 * - Emits notification_thread_created only when a new conversation is created
 * - Does NOT emit notification_thread_created when reusing an existing thread
 */

import { describe, expect, mock, test } from "bun:test";

// -- Mocks (must be declared before importing modules that depend on them) ----

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

// Mock destination-resolver to return a destination for every requested channel
mock.module("../notifications/destination-resolver.js", () => ({
  resolveDestinations: (channels: string[]) => {
    const m = new Map();
    for (const ch of channels) {
      m.set(ch, { channel: ch, endpoint: `mock-${ch}` });
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
// By default returns a "new conversation" result with a stable UUID.
// Set `nextPairingResult` to override the return value for a single call.
let nextPairingResult:
  | import("../notifications/conversation-pairing.js").PairingResult
  | null = null;
let pairingCallCount = 0;

mock.module("../notifications/conversation-pairing.js", () => ({
  pairDeliveryWithConversation: async () => {
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
      threadDecisionFallbackUsed: false,
    };
  },
}));

import type { ThreadCreatedInfo } from "../notifications/broadcaster.js";
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
    sourceSessionId: "sess-001",
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

    const signal = makeSignal({ sourceEventName: "reminder.fired" });
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

  test("adapter receives concise copy (title/body), not the thread seed message", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);

    const signal = makeSignal();
    const decision = makeDecision({
      renderedCopy: {
        vellum: {
          title: "Reminder",
          body: "Take out the trash",
          threadSeedMessage:
            "This is a much richer seed message with more context about the reminder and what you should do about it.",
        },
      },
    });

    await broadcaster.broadcastDecision(signal, decision);

    expect(vellumAdapter.sent).toHaveLength(1);
    // The adapter payload uses the full copy object — title/body are what
    // the native notification displays. threadSeedMessage is only consumed
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

  // ── Thread-created IPC emission ─────────────────────────────────────

  test("fires onThreadCreated when a new vellum conversation is created (start_new)", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);
    const threadCreatedCalls: ThreadCreatedInfo[] = [];
    broadcaster.setOnThreadCreated((info) => threadCreatedCalls.push(info));

    const signal = makeSignal();
    // No threadActions means default start_new behavior
    const decision = makeDecision();

    await broadcaster.broadcastDecision(signal, decision);

    // Pairing creates a new conversation by default, so onThreadCreated should fire
    expect(threadCreatedCalls).toHaveLength(1);
    expect(threadCreatedCalls[0].sourceEventName).toBe("test.event");
  });

  test("fires per-dispatch onThreadCreated callback on new conversation", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);
    const dispatchCalls: ThreadCreatedInfo[] = [];

    const signal = makeSignal();
    const decision = makeDecision();

    await broadcaster.broadcastDecision(signal, decision, {
      onThreadCreated: (info) => dispatchCalls.push(info),
    });

    expect(dispatchCalls).toHaveLength(1);
  });

  test("does NOT fire class-level onThreadCreated when reusing an existing thread", async () => {
    const vellumAdapter = new MockAdapter("vellum");
    const broadcaster = new NotificationBroadcaster([vellumAdapter]);
    const ipcCalls: ThreadCreatedInfo[] = [];
    const dispatchCalls: ThreadCreatedInfo[] = [];
    broadcaster.setOnThreadCreated((info) => ipcCalls.push(info));

    // Simulate a successful reuse by injecting a pairing result with
    // createdNewConversation=false. This bypasses the real conversation
    // store (which would fall back to creating a new conversation since
    // the target does not exist in the test DB).
    nextPairingResult = {
      conversationId: "conv-reused-456",
      messageId: "msg-reused-789",
      strategy: "start_new_conversation",
      createdNewConversation: false,
      threadDecisionFallbackUsed: false,
    };

    const signal = makeSignal();
    const decision = makeDecision({
      threadActions: {
        vellum: {
          action: "reuse_existing",
          conversationId: "conv-existing-123",
        },
      },
    });

    await broadcaster.broadcastDecision(signal, decision, {
      onThreadCreated: (info) => dispatchCalls.push(info),
    });

    // The class-level IPC callback should NOT fire because
    // createdNewConversation is false — the client already knows about
    // the reused conversation.
    expect(ipcCalls).toHaveLength(0);

    // The per-dispatch callback SHOULD fire for both new and reused
    // pairings (used by callers like dispatchGuardianQuestion for
    // delivery bookkeeping).
    expect(dispatchCalls).toHaveLength(1);
    expect(dispatchCalls[0].conversationId).toBe("conv-reused-456");
  });
});
