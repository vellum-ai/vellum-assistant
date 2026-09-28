import { beforeAll, expect, mock, test } from "bun:test";

import type { NotificationSignal } from "../signal.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  NotificationChannel,
  NotificationDecision,
} from "../types.js";

mock.module("../../config/assistant-initiated-threads-gate.js", () => ({
  isAssistantInitiatedThreadsEnabled: () => true,
}));
const guardianReader =
  await import("../../contacts/guardian-delivery-reader.js");
mock.module("../../contacts/guardian-delivery-reader.js", () => ({
  ...guardianReader,
  getGuardianDelivery: async () => null,
}));
mock.module("../destination-resolver.js", () => ({
  resolveDestinations: (channels: NotificationChannel[]) =>
    new Map(channels.map((channel) => [channel, { channel }])),
}));

const { createConversation, getConversation, getMessageById, getMessages } =
  await import("../../persistence/conversation-crud.js");
const { initializeDb } = await import("../../persistence/db-init.js");
const { resolveAssistantInitiatedThread } =
  await import("../assistant-initiated-thread.js");
const { NotificationBroadcaster } = await import("../broadcaster.js");
const { createDecision } = await import("../decisions-store.js");
const { findDeliveryByDecisionAndChannel } =
  await import("../deliveries-store.js");
const { createEvent } = await import("../events-store.js");

beforeAll(async () => {
  await initializeDb();
});

function persistedShare() {
  const producer = createConversation({ conversationType: "background" });
  const signal: NotificationSignal = {
    signalId: crypto.randomUUID(),
    createdAt: Date.now(),
    sourceChannel: "assistant_tool",
    sourceContextId: producer.id,
    sourceEventName: "assistant.share",
    contextPayload: {},
    attentionHints: {
      requiresAction: false,
      urgency: "low",
      isAsyncBackground: true,
      visibleInSourceNow: false,
    },
  };
  createEvent({
    id: signal.signalId,
    sourceEventName: signal.sourceEventName,
    sourceChannel: signal.sourceChannel,
    sourceContextId: signal.sourceContextId,
    attentionHints: signal.attentionHints,
    payload: signal.contextPayload,
  });
  const decision: NotificationDecision & { persistedDecisionId: string } = {
    persistedDecisionId: crypto.randomUUID(),
    shouldNotify: true,
    selectedChannels: ["vellum", "platform"],
    reasoningSummary: "Share a useful update",
    renderedCopy: {
      vellum: { title: "A useful update", body: "The report is ready." },
    },
    dedupeKey: signal.signalId,
    confidence: 1,
    fallbackUsed: false,
  };
  createDecision({
    ...decision,
    id: decision.persistedDecisionId,
    notificationEventId: signal.signalId,
  });
  return {
    signal,
    decision,
    options: {
      assistantInitiatedThread: {
        resolution: resolveAssistantInitiatedThread(signal),
        platformAdded: true,
      },
    },
  };
}

function recordingAdapter(channel: "vellum" | "platform") {
  const sent: ChannelDeliveryPayload[] = [];
  const readableAtSend: boolean[] = [];
  const adapter: ChannelAdapter = {
    channel,
    async send(payload) {
      const conversationId = payload.deepLinkTarget?.conversationId;
      const messageId = payload.deepLinkTarget?.messageId;
      readableAtSend.push(
        typeof conversationId === "string" &&
          typeof messageId === "string" &&
          getConversation(conversationId)?.source === "assistant_initiated" &&
          getMessageById(messageId, conversationId) != null,
      );
      sent.push(payload);
      return {
        success: true,
        ...(channel === "platform"
          ? { remotePushAccepted: true, remotePushPlatforms: ["ios" as const] }
          : {}),
      };
    },
  };
  return { adapter, sent, readableAtSend };
}

test("new From me alerts address the saved chat and seed before either adapter sends", async () => {
  const { signal, decision, options } = persistedShare();
  const local = recordingAdapter("vellum");
  const push = recordingAdapter("platform");
  const broadcaster = new NotificationBroadcaster([
    local.adapter,
    push.adapter,
  ]);
  const created: Array<{
    source?: string;
    silent: boolean;
    seedCount: number;
  }> = [];
  broadcaster.setOnConversationCreated((info) => {
    created.push({
      source: info.source,
      silent: info.silent,
      seedCount: getMessages(info.conversationId).length,
    });
  });

  await broadcaster.broadcastDecision(signal, decision, options);

  expect(created).toEqual([
    { source: "assistant_initiated", silent: false, seedCount: 1 },
  ]);
  expect(local.readableAtSend).toEqual([true]);
  expect(push.readableAtSend).toEqual([true]);
  expect(local.sent[0]).toMatchObject({
    silent: false,
    urgency: "low",
    correlationId: signal.signalId,
    remotePushDispatched: true,
    remotePushPlatforms: ["ios"],
  });
  expect(push.sent[0].deepLinkTarget).toEqual(local.sent[0].deepLinkTarget);
  const conversationId = local.sent[0].deepLinkTarget?.conversationId as string;
  expect(conversationId).not.toBe(signal.sourceContextId);
  expect(getMessages(conversationId)).toHaveLength(1);
  expect(getMessages(signal.sourceContextId)).toHaveLength(0);
});

test("a missing platform delivery reuses the saved initial-creation audit without reseeding", async () => {
  const { signal, decision, options } = persistedShare();
  const local = recordingAdapter("vellum");
  await new NotificationBroadcaster([local.adapter]).broadcastDecision(
    signal,
    decision,
    options,
  );
  const initial = findDeliveryByDecisionAndChannel(
    decision.persistedDecisionId,
    "vellum",
  );
  expect(initial).toMatchObject({
    conversationStrategy: "start_new_conversation",
    conversationAction: "start_new",
    status: "sent",
  });

  const push = recordingAdapter("platform");
  const retry = new NotificationBroadcaster([local.adapter, push.adapter]);
  await retry.broadcastDecision(signal, decision, options);
  await retry.broadcastDecision(signal, decision, options);

  expect(local.sent).toHaveLength(1);
  expect(push.sent).toHaveLength(1);
  expect(push.readableAtSend).toEqual([true]);
  expect(push.sent[0].deepLinkTarget).toMatchObject({
    conversationId: initial?.conversationId,
    messageId: initial?.messageId,
  });
  expect(getMessages(initial!.conversationId!)).toHaveLength(1);
});
