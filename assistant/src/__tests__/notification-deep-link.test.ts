/**
 * Regression tests for Vellum notification deep-link metadata.
 *
 * Validates that the VellumAdapter broadcasts notification_intent with
 * deepLinkMetadata, and that the broadcaster correctly passes deepLinkTarget
 * from the decision through to the adapter payload — regardless of whether
 * the conversation was newly created or reused.
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

// Mock destination-resolver for broadcaster tests
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
  findDeliveryByDecisionAndChannel: () => undefined,
}));

// Configurable mock for conversation-pairing
let nextPairingResult:
  | import("../notifications/conversation-pairing.js").PairingResult
  | null = null;
let pairingCallCount = 0;

mock.module("../notifications/conversation-pairing.js", () => ({
  pairDeliveryWithConversation: async (
    _signal: unknown,
    _channel: string,
    _copy: unknown,
    _options?: PairingOptions,
  ) => {
    if (nextPairingResult) {
      const result = nextPairingResult;
      nextPairingResult = null;
      return result;
    }
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

import type { ServerMessage } from "../daemon/message-protocol.js";
import { VellumAdapter } from "../notifications/adapters/macos.js";
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
    signalId: "sig-deeplink-001",
    createdAt: Date.now(),
    sourceChannel: "scheduler",
    sourceConversationId: "sess-001",
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
    reasoningSummary: "Deep-link test decision",
    renderedCopy: {
      vellum: { title: "Test Alert", body: "Something happened" },
    },
    dedupeKey: "deeplink-test-001",
    confidence: 0.9,
    fallbackUsed: false,
    ...overrides,
  };
}

class MockAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel;
  sent: ChannelDeliveryPayload[] = [];

  constructor(channel: NotificationChannel) {
    this.channel = channel;
  }

  async send(
    payload: ChannelDeliveryPayload,
    _dest: ChannelDestination,
  ): Promise<DeliveryResult> {
    this.sent.push(payload);
    return { success: true };
  }
}

// -- Tests -------------------------------------------------------------------

describe("notification deep-link metadata", () => {
  beforeEach(() => {
    nextPairingResult = null;
  });

  describe("VellumAdapter", () => {
    test("broadcasts notification_intent with deepLinkMetadata from payload", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      await adapter.send(
        {
          sourceEventName: "test.event",
          copy: { title: "Alert", body: "Something happened" },
          deepLinkTarget: {
            conversationId: "conv-123",
            conversationType: "notification",
          },
        },
        { channel: "vellum" },
      );

      expect(messages).toHaveLength(1);
      const msg = messages[0] as unknown as Record<string, unknown>;
      expect(msg.type).toBe("notification_intent");
      expect(msg.title).toBe("Alert");
      expect(msg.body).toBe("Something happened");
      expect(msg.deepLinkMetadata).toEqual({
        conversationId: "conv-123",
        conversationType: "notification",
      });
    });

    test("broadcasts notification_intent without deepLinkMetadata when absent", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      await adapter.send(
        {
          sourceEventName: "test.event",
          copy: { title: "Alert", body: "No deep link" },
        },
        { channel: "vellum" },
      );

      expect(messages).toHaveLength(1);
      const msg = messages[0] as unknown as Record<string, unknown>;
      expect(msg.type).toBe("notification_intent");
      expect(msg.deepLinkMetadata).toBeUndefined();
    });

    test("includes conversationId in deepLinkMetadata for navigation", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      const conversationId = "conv-deep-link-test";
      await adapter.send(
        {
          sourceEventName: "guardian.question",
          copy: { title: "Guardian Question", body: "What is the code?" },
          deepLinkTarget: { conversationId },
        },
        { channel: "vellum" },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      const metadata = msg.deepLinkMetadata as Record<string, unknown>;
      expect(metadata.conversationId).toBe(conversationId);
    });

    test("returns success: true on successful broadcast", async () => {
      const adapter = new VellumAdapter(() => {});

      const result = await adapter.send(
        {
          sourceEventName: "test.event",
          copy: { title: "T", body: "B" },
        },
        { channel: "vellum" },
      );

      expect(result.success).toBe(true);
    });

    test("returns success: false when broadcast throws", async () => {
      const adapter = new VellumAdapter(() => {
        throw new Error("connection lost");
      });

      const result = await adapter.send(
        {
          sourceEventName: "test.event",
          copy: { title: "T", body: "B" },
        },
        { channel: "vellum" },
      );

      expect(result.success).toBe(false);
      expect(result.error).toContain("connection lost");
    });

    test("sourceEventName is included in the event payload", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      await adapter.send(
        {
          sourceEventName: "guardian.question",
          copy: { title: "Alert", body: "Body" },
        },
        { channel: "vellum" },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      expect(msg.sourceEventName).toBe("guardian.question");
    });

    test("deepLinkMetadata with conversationId enables client-side navigation", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      // Simulate a notification that should deep-link to a specific conversation
      await adapter.send(
        {
          sourceEventName: "activity.complete",
          copy: { title: "Task Done", body: "Your task has completed" },
          deepLinkTarget: {
            conversationId: "conv-task-run-42",
            workItemId: "work-item-7",
          },
        },
        { channel: "vellum" },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      const metadata = msg.deepLinkMetadata as Record<string, unknown>;
      expect(metadata.conversationId).toBe("conv-task-run-42");
      expect(metadata.workItemId).toBe("work-item-7");
    });

    test("deep-link payload includes messageId when present", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      await adapter.send(
        {
          sourceEventName: "guardian.question",
          copy: { title: "Question", body: "Body" },
          deepLinkTarget: { conversationId: "conv-1", messageId: "msg-1" },
        },
        { channel: "vellum" },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      const metadata = msg.deepLinkMetadata as Record<string, unknown>;
      expect(metadata.messageId).toBe("msg-1");
    });

    // ── Deep-link conversationId present regardless of reuse/new ──────

    test("deep-link payload includes conversationId for a newly created conversation", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      // Simulates the broadcaster merging pairing.conversationId into deep-link
      // for a newly created notification conversation (start_new path)
      await adapter.send(
        {
          sourceEventName: "schedule.notify",
          copy: { title: "Reminder", body: "Take out the trash" },
          deepLinkTarget: { conversationId: "conv-new-convo-001" },
        },
        { channel: "vellum" },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      const metadata = msg.deepLinkMetadata as Record<string, unknown>;
      expect(metadata.conversationId).toBe("conv-new-convo-001");
    });

    test("deep-link payload includes conversationId for a reused conversation", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      // Simulates the broadcaster merging pairing.conversationId into deep-link
      // for a reused notification conversation (reuse_existing path)
      await adapter.send(
        {
          sourceEventName: "schedule.notify",
          copy: {
            title: "Follow-up",
            body: "Still need to take out the trash",
          },
          deepLinkTarget: { conversationId: "conv-reused-convo-042" },
        },
        { channel: "vellum" },
      );

      const msg = messages[0] as unknown as Record<string, unknown>;
      const metadata = msg.deepLinkMetadata as Record<string, unknown>;
      expect(metadata.conversationId).toBe("conv-reused-convo-042");
    });

    // ── Reused conversation deep-link stability regressions ─────────────────

    test("reused conversation preserves the same conversationId across follow-up notifications", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      const stableConversationId = "conv-bound-telegram-dest-001";

      // First notification to a bound destination
      await adapter.send(
        {
          sourceEventName: "guardian.question",
          copy: { title: "Question 1", body: "Allow file read?" },
          deepLinkTarget: {
            conversationId: stableConversationId,
            messageId: "msg-seed-1",
          },
        },
        { channel: "vellum" },
      );

      // Follow-up notification reuses the same bound conversation
      await adapter.send(
        {
          sourceEventName: "guardian.question",
          copy: { title: "Question 2", body: "Allow network access?" },
          deepLinkTarget: {
            conversationId: stableConversationId,
            messageId: "msg-seed-2",
          },
        },
        { channel: "vellum" },
      );

      expect(messages).toHaveLength(2);

      const meta1 = (messages[0] as unknown as Record<string, unknown>)
        .deepLinkMetadata as Record<string, unknown>;
      const meta2 = (messages[1] as unknown as Record<string, unknown>)
        .deepLinkMetadata as Record<string, unknown>;

      // Both deep links point to the same conversation
      expect(meta1.conversationId).toBe(stableConversationId);
      expect(meta2.conversationId).toBe(stableConversationId);

      // But each has a distinct messageId for scroll-to-message targeting
      expect(meta1.messageId).toBe("msg-seed-1");
      expect(meta2.messageId).toBe("msg-seed-2");
    });

    test("reused conversation deep-link messageId changes per delivery for scroll targeting", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      const conversationId = "conv-reused-scroll-test";

      await adapter.send(
        {
          sourceEventName: "schedule.notify",
          copy: { title: "Reminder", body: "First" },
          deepLinkTarget: { conversationId, messageId: "msg-a" },
        },
        { channel: "vellum" },
      );

      await adapter.send(
        {
          sourceEventName: "schedule.notify",
          copy: { title: "Reminder", body: "Second" },
          deepLinkTarget: { conversationId, messageId: "msg-b" },
        },
        { channel: "vellum" },
      );

      const meta1 = (messages[0] as unknown as Record<string, unknown>)
        .deepLinkMetadata as Record<string, unknown>;
      const meta2 = (messages[1] as unknown as Record<string, unknown>)
        .deepLinkMetadata as Record<string, unknown>;

      // Same conversation but different message targets
      expect(meta1.conversationId).toBe(conversationId);
      expect(meta2.conversationId).toBe(conversationId);
      expect(meta1.messageId).not.toBe(meta2.messageId);
    });

    test("deep-link metadata is stable when conversation is reused via binding-key continuation", async () => {
      const messages: ServerMessage[] = [];
      const adapter = new VellumAdapter((msg) => messages.push(msg));

      // Simulates the binding-key continuation path: multiple notifications
      // to the same voice destination reuse the same bound conversation, and
      // the deep-link metadata should reflect the bound conversation ID
      // rather than creating a new one each time.
      const boundConvId = "conv-voice-bound-+15551234567";

      for (const body of ["Alert 1", "Alert 2", "Alert 3"]) {
        await adapter.send(
          {
            sourceEventName: "activity.complete",
            copy: { title: "Activity", body },
            deepLinkTarget: { conversationId: boundConvId },
          },
          { channel: "vellum" },
        );
      }

      expect(messages).toHaveLength(3);

      // All three notifications deep-link to the same bound conversation
      for (const msg of messages) {
        const metadata = (msg as unknown as Record<string, unknown>)
          .deepLinkMetadata as Record<string, unknown>;
        expect(metadata.conversationId).toBe(boundConvId);
      }
    });
  });

  // ── NotificationBroadcaster deep-link injection ──────────────────────
  //
  // These tests exercise the production code path where the broadcaster
  // calls pairDeliveryWithConversation() and merges the pairing result's
  // conversationId/messageId into deepLinkTarget before passing to the
  // adapter. This catches regressions that the adapter-only tests above
  // would miss (e.g. broadcaster stops merging pairing results).

  describe("NotificationBroadcaster deep-link injection", () => {
    test("broadcaster merges pairing conversationId into deepLinkTarget for vellum", async () => {
      const vellumAdapter = new MockAdapter("vellum");
      const broadcaster = new NotificationBroadcaster([vellumAdapter]);

      nextPairingResult = {
        conversationId: "conv-paired-abc",
        messageId: "msg-paired-abc",
        strategy: "start_new_conversation" as const,
        createdNewConversation: true,
        conversationFallbackUsed: false,
      };

      const signal = makeSignal();
      const decision = makeDecision();

      await broadcaster.broadcastDecision(signal, decision);

      expect(vellumAdapter.sent).toHaveLength(1);
      const deepLink = vellumAdapter.sent[0].deepLinkTarget;
      expect(deepLink).toBeDefined();
      expect(deepLink!.conversationId).toBe("conv-paired-abc");
    });

    test("broadcaster merges pairing messageId into deepLinkTarget for vellum", async () => {
      const vellumAdapter = new MockAdapter("vellum");
      const broadcaster = new NotificationBroadcaster([vellumAdapter]);

      nextPairingResult = {
        conversationId: "conv-paired-def",
        messageId: "msg-paired-def",
        strategy: "start_new_conversation" as const,
        createdNewConversation: true,
        conversationFallbackUsed: false,
      };

      const signal = makeSignal();
      const decision = makeDecision();

      await broadcaster.broadcastDecision(signal, decision);

      expect(vellumAdapter.sent).toHaveLength(1);
      const deepLink = vellumAdapter.sent[0].deepLinkTarget;
      expect(deepLink).toBeDefined();
      expect(deepLink!.messageId).toBe("msg-paired-def");
    });

    test("reused conversation deep-link points to the reused conversationId", async () => {
      const vellumAdapter = new MockAdapter("vellum");
      const broadcaster = new NotificationBroadcaster([vellumAdapter]);

      nextPairingResult = {
        conversationId: "conv-reused-xyz",
        messageId: "msg-reused-xyz",
        strategy: "start_new_conversation" as const,
        createdNewConversation: false,
        conversationFallbackUsed: false,
      };

      const signal = makeSignal();
      const decision = makeDecision({
        conversationActions: {
          vellum: {
            action: "reuse_existing",
            conversationId: "conv-original-placeholder",
          },
        },
      });

      await broadcaster.broadcastDecision(signal, decision);

      expect(vellumAdapter.sent).toHaveLength(1);
      const deepLink = vellumAdapter.sent[0].deepLinkTarget;
      expect(deepLink).toBeDefined();
      // The deep-link should use the pairing result, not the original placeholder
      expect(deepLink!.conversationId).toBe("conv-reused-xyz");
    });

    test("deep-link conversationId is stable across multiple deliveries to the same reused conversation", async () => {
      const vellumAdapter = new MockAdapter("vellum");
      const broadcaster = new NotificationBroadcaster([vellumAdapter]);

      const stableConvId = "conv-stable-reuse-001";

      // First delivery
      nextPairingResult = {
        conversationId: stableConvId,
        messageId: "msg-delivery-1",
        strategy: "start_new_conversation" as const,
        createdNewConversation: false,
        conversationFallbackUsed: false,
      };

      await broadcaster.broadcastDecision(makeSignal(), makeDecision());

      // Second delivery — same conversation reused via binding-key
      nextPairingResult = {
        conversationId: stableConvId,
        messageId: "msg-delivery-2",
        strategy: "start_new_conversation" as const,
        createdNewConversation: false,
        conversationFallbackUsed: false,
      };

      await broadcaster.broadcastDecision(makeSignal(), makeDecision());

      expect(vellumAdapter.sent).toHaveLength(2);

      const deepLink1 = vellumAdapter.sent[0].deepLinkTarget;
      const deepLink2 = vellumAdapter.sent[1].deepLinkTarget;

      // Both deliveries point to the same stable conversation
      expect(deepLink1!.conversationId).toBe(stableConvId);
      expect(deepLink2!.conversationId).toBe(stableConvId);

      // But each has a distinct messageId for scroll targeting
      expect(deepLink1!.messageId).toBe("msg-delivery-1");
      expect(deepLink2!.messageId).toBe("msg-delivery-2");
    });
  });
});
