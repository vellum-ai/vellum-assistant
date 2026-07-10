import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    slack: {
      teamId: "T123",
      teamUrl: "https://example.slack.com/",
    },
  }),
}));

import { eq } from "drizzle-orm";

import {
  getConversationByKey,
  setConversationKey,
} from "../persistence/conversation-key-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  clearPayload,
  findMessageBySourceId,
  linkMessage,
  recordInbound,
  storePayload,
} from "../persistence/delivery-crud.js";
import {
  acknowledgeDelivery,
  getDeadLetterEvents,
  getRetryableDeliveryEvents,
  getRetryableEvents,
  markDeliveryDelivered,
  markProcessed,
  recordDeliveryFailure,
  recordProcessingFailure,
  replayDeadLetters,
} from "../persistence/delivery-status.js";
import {
  getBindingByChannelChat,
  getBindingByChannelChatThread,
  upsertBinding,
} from "../persistence/external-conversation-store.js";
import { RETRY_MAX_ATTEMPTS } from "../persistence/job-utils.js";
import {
  channelInboundEvents,
  conversations,
  externalConversationBindings,
  messages,
} from "../persistence/schema/index.js";
import { buildConversationDetailResponse } from "../runtime/services/conversation-serializer.js";
import { handleDeleteConversation } from "./helpers/channel-test-adapter.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM external_conversation_bindings");
  db.run("DELETE FROM conversations");
}

/** Insert a message row so FK constraints on channel_inbound_events.message_id pass. */
function insertMessage(
  id: string,
  conversationId: string,
  metadata?: Record<string, unknown>,
): void {
  const db = getDb();
  db.insert(messages)
    .values({
      id,
      conversationId,
      role: "user",
      content: "test message",
      createdAt: Date.now(),
      metadata: metadata ? JSON.stringify(metadata) : null,
    })
    .run();
}

describe("channel-delivery-store", () => {
  beforeEach(() => {
    resetTables();
  });

  // ── Recording inbound events ──────────────────────────────────────

  test("records an inbound event and creates a conversation", () => {
    const result = recordInbound("telegram", "chat-1", "msg-1");

    expect(result.accepted).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.eventId).toBeDefined();
    expect(result.conversationId).toBeDefined();

    const db = getDb();
    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();

    expect(row).toBeDefined();
    expect(row!.sourceChannel).toBe("telegram");
    expect(row!.externalChatId).toBe("chat-1");
    expect(row!.externalMessageId).toBe("msg-1");
    expect(row!.deliveryStatus).toBe("pending");
    expect(row!.processingStatus).toBe("pending");
    expect(row!.processingAttempts).toBe(0);
  });

  test("records inbound with sourceMessageId option", () => {
    const result = recordInbound("telegram", "chat-1", "msg-1", {
      sourceMessageId: "src-42",
    });

    const db = getDb();
    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();

    expect(row!.sourceMessageId).toBe("src-42");
  });

  test("same chat on same channel reuses the same conversation", () => {
    const r1 = recordInbound("telegram", "chat-1", "msg-1");
    const r2 = recordInbound("telegram", "chat-1", "msg-2");

    expect(r1.conversationId).toBe(r2.conversationId);
  });

  test("same Slack channel and thread reuses the same conversation", () => {
    const r1 = recordInbound("slack", "C0123ABCDEF", "msg-1", {
      sourceThreadId: "1710000000.000100",
    });
    const r2 = recordInbound("slack", "C0123ABCDEF", "msg-2", {
      sourceThreadId: "1710000000.000100",
    });

    expect(r1.conversationId).toBe(r2.conversationId);
  });

  test("different Slack threads in one channel get different conversations", () => {
    const r1 = recordInbound("slack", "C0123ABCDEF", "msg-1", {
      sourceThreadId: "1710000000.000100",
    });
    const r2 = recordInbound("slack", "C0123ABCDEF", "msg-2", {
      sourceThreadId: "1710000000.000200",
    });

    expect(r1.conversationId).not.toBe(r2.conversationId);
  });

  test("legacy Slack channel key with matching inbound root ts gets aliased to the threaded key", () => {
    const channelId = "C0123ABCDEF";
    const threadTs = "1710000000.000100";
    const legacy = recordInbound("slack", channelId, "legacy-event", {
      sourceMessageId: threadTs,
    });

    const threaded = recordInbound("slack", channelId, "thread-reply", {
      sourceThreadId: threadTs,
      sourceMessageId: "1710000001.000100",
    });

    expect(threaded.conversationId).toBe(legacy.conversationId);
    expect(
      getConversationByKey(`asst:self:slack:${channelId}:thread:${threadTs}`)
        ?.conversationId,
    ).toBe(legacy.conversationId);
  });

  test("legacy Slack channel key with matching slackMeta.threadTs evidence gets aliased to the threaded key", () => {
    const channelId = "C0123ABCDEF";
    const threadTs = "1710000000.000200";
    const legacy = recordInbound("slack", channelId, "legacy-event", {
      sourceMessageId: "1710000000.999999",
    });
    insertMessage("legacy-thread-message", legacy.conversationId, {
      slackMeta: JSON.stringify({
        source: "slack",
        channelId,
        channelTs: "1710000001.000200",
        threadTs,
        eventKind: "message",
      }),
    });

    const threaded = recordInbound("slack", channelId, "thread-reply", {
      sourceThreadId: threadTs,
      sourceMessageId: "1710000002.000200",
    });

    expect(threaded.conversationId).toBe(legacy.conversationId);
    expect(
      getConversationByKey(`asst:self:slack:${channelId}:thread:${threadTs}`)
        ?.conversationId,
    ).toBe(legacy.conversationId);
  });

  test("legacy Slack thread evidence scan is bounded when metadata does not prove the thread", () => {
    const channelId = "C0123ABCDEF";
    const legacy = recordInbound("slack", channelId, "legacy-event", {
      sourceMessageId: "1710000000.000100",
    });
    for (let i = 0; i < 550; i++) {
      insertMessage(`legacy-thread-message-${i}`, legacy.conversationId, {
        slackMeta: JSON.stringify({
          source: "slack",
          channelId,
          channelTs: `1710000001.${String(i).padStart(6, "0")}`,
          threadTs: "1710000000.000100",
          eventKind: "message",
        }),
      });
    }
    insertMessage("legacy-thread-message-target", legacy.conversationId, {
      slackMeta: JSON.stringify({
        source: "slack",
        channelId,
        channelTs: "1710000002.000600",
        threadTs: "1710000000.000600",
        eventKind: "message",
      }),
    });

    const threaded = recordInbound("slack", channelId, "thread-reply", {
      sourceThreadId: "1710000000.000600",
      sourceMessageId: "1710000003.000600",
    });

    expect(threaded.conversationId).not.toBe(legacy.conversationId);
  });

  test("legacy Slack channel key without evidence for the requested thread is not reused", () => {
    const channelId = "C0123ABCDEF";
    const legacy = recordInbound("slack", channelId, "legacy-event", {
      sourceMessageId: "1710000000.000100",
    });
    insertMessage("legacy-other-thread-message", legacy.conversationId, {
      slackMeta: JSON.stringify({
        source: "slack",
        channelId,
        channelTs: "1710000001.000100",
        threadTs: "1710000000.000100",
        eventKind: "message",
      }),
    });

    const threaded = recordInbound("slack", channelId, "new-thread-reply", {
      sourceThreadId: "1710000000.000300",
      sourceMessageId: "1710000001.000300",
    });

    expect(threaded.conversationId).not.toBe(legacy.conversationId);
    expect(
      getConversationByKey(
        `asst:self:slack:${channelId}:thread:1710000000.000300`,
      )?.conversationId,
    ).toBe(threaded.conversationId);
  });

  test("aliasing a proven legacy Slack thread does not collapse different thread IDs", () => {
    const channelId = "C0123ABCDEF";
    const legacyThreadTs = "1710000000.000100";
    const newThreadTs = "1710000000.000200";
    const legacy = recordInbound("slack", channelId, "legacy-event", {
      sourceMessageId: legacyThreadTs,
    });

    const aliased = recordInbound("slack", channelId, "legacy-thread-reply", {
      sourceThreadId: legacyThreadTs,
      sourceMessageId: "1710000001.000100",
    });
    const separate = recordInbound("slack", channelId, "new-thread-reply", {
      sourceThreadId: newThreadTs,
      sourceMessageId: "1710000001.000200",
    });

    expect(aliased.conversationId).toBe(legacy.conversationId);
    expect(separate.conversationId).not.toBe(legacy.conversationId);
    expect(separate.conversationId).not.toBe(aliased.conversationId);
  });

  test("reset legacy-aliased Slack thread does not reattach to old legacy conversation", async () => {
    const channelId = "C0123ABCDEF";
    const threadTs = "1710000000.000100";
    const legacy = recordInbound("slack", channelId, "legacy-event", {
      sourceMessageId: threadTs,
    });
    const aliased = recordInbound("slack", channelId, "legacy-thread-reply", {
      sourceThreadId: threadTs,
      sourceMessageId: "1710000001.000100",
    });
    expect(aliased.conversationId).toBe(legacy.conversationId);

    const req = new Request("http://localhost/channels/conversation", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "slack",
        conversationExternalId: channelId,
        sourceThreadId: threadTs,
      }),
    });
    const res = await handleDeleteConversation(req);
    expect(res.status).toBe(200);

    const afterReset = recordInbound("slack", channelId, "after-reset-reply", {
      sourceThreadId: threadTs,
      sourceMessageId: "1710000002.000100",
    });

    expect(afterReset.conversationId).not.toBe(legacy.conversationId);
    expect(
      getConversationByKey(`asst:self:slack:${channelId}:thread:${threadTs}`)
        ?.conversationId,
    ).toBe(afterReset.conversationId);
  });

  test("reset legacy Slack thread before alias exists does not reattach to old legacy conversation", async () => {
    const channelId = "C0123ABCDEF";
    const threadTs = "1710000000.000100";
    const legacy = recordInbound("slack", channelId, "legacy-event", {
      sourceMessageId: threadTs,
    });

    const req = new Request("http://localhost/channels/conversation", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "slack",
        conversationExternalId: channelId,
        sourceThreadId: threadTs,
      }),
    });
    const res = await handleDeleteConversation(req);
    expect(res.status).toBe(200);

    const afterReset = recordInbound("slack", channelId, "after-reset-reply", {
      sourceThreadId: threadTs,
      sourceMessageId: "1710000002.000100",
    });

    expect(afterReset.conversationId).not.toBe(legacy.conversationId);
    expect(
      getConversationByKey(`asst:self:slack:${channelId}:thread:${threadTs}`)
        ?.conversationId,
    ).toBe(afterReset.conversationId);
  });

  test("different chats get different conversations", () => {
    const r1 = recordInbound("telegram", "chat-1", "msg-1");
    const r2 = recordInbound("telegram", "chat-2", "msg-1");

    expect(r1.conversationId).not.toBe(r2.conversationId);
  });

  test("different channels get different conversations", () => {
    const r1 = recordInbound("telegram", "chat-1", "msg-1");
    const r2 = recordInbound("slack", "chat-1", "msg-1");

    expect(r1.conversationId).not.toBe(r2.conversationId);
  });

  test("same chat/channel but different assistantId uses different conversations", () => {
    const r1 = recordInbound("telegram", "chat-1", "msg-1", {
      assistantId: "asst-A",
    });
    const r2 = recordInbound("telegram", "chat-1", "msg-2", {
      assistantId: "asst-B",
    });

    expect(r1.conversationId).not.toBe(r2.conversationId);
  });

  test("no assistantId defaults to self-scoped key", () => {
    const r1 = recordInbound("telegram", "chat-1", "msg-1");
    const r2 = recordInbound("telegram", "chat-1", "msg-2", {
      assistantId: "self",
    });
    expect(r1.conversationId).toBe(r2.conversationId);
  });

  test("external bindings allow multiple Slack thread anchors per channel", () => {
    const r1 = recordInbound("slack", "C0123ABCDEF", "msg-1", {
      sourceThreadId: "1710000000.000100",
    });
    const r2 = recordInbound("slack", "C0123ABCDEF", "msg-2", {
      sourceThreadId: "1710000000.000200",
    });

    upsertBinding({
      conversationId: r1.conversationId,
      sourceChannel: "slack",
      externalChatId: "C0123ABCDEF",
      externalThreadId: "1710000000.000100",
    });
    upsertBinding({
      conversationId: r2.conversationId,
      sourceChannel: "slack",
      externalChatId: "C0123ABCDEF",
      externalThreadId: "1710000000.000200",
    });

    expect(
      getBindingByChannelChatThread("slack", "C0123ABCDEF", "1710000000.000100")
        ?.conversationId,
    ).toBe(r1.conversationId);
    expect(
      getBindingByChannelChatThread("slack", "C0123ABCDEF", "1710000000.000200")
        ?.conversationId,
    ).toBe(r2.conversationId);
    expect(getBindingByChannelChat("slack", "C0123ABCDEF")).toBeNull();
  });

  test("conversation detail exposes Slack thread anchor from binding", () => {
    const result = recordInbound("slack", "C0123ABCDEF", "msg-1", {
      sourceThreadId: "1710000000.000100",
    });

    upsertBinding({
      conversationId: result.conversationId,
      sourceChannel: "slack",
      externalChatId: "C0123ABCDEF",
      externalChatName: "engineering",
      externalThreadId: "1710000000.000100",
    });

    const detail = buildConversationDetailResponse(result.conversationId);

    expect(detail?.conversation.channelBinding).toMatchObject({
      sourceChannel: "slack",
      externalChatId: "C0123ABCDEF",
      externalChatName: "engineering",
      externalThreadId: "1710000000.000100",
      slackThread: {
        channelId: "C0123ABCDEF",
        threadTs: "1710000000.000100",
        link: {
          appUrl:
            "slack://channel?team=T123&id=C0123ABCDEF&message=1710000000.000100",
          webUrl:
            "https://example.slack.com/archives/C0123ABCDEF/p1710000000000100",
        },
      },
      slackChannel: {
        channelId: "C0123ABCDEF",
        name: "engineering",
        link: {
          webUrl: "https://example.slack.com/archives/C0123ABCDEF",
        },
      },
    });
  });

  test("conversation detail exposes Slack channel id fallback without stored channel name", () => {
    const result = recordInbound("slack", "C0123ABCDEF", "msg-1", {
      sourceThreadId: "1710000000.000100",
    });

    upsertBinding({
      conversationId: result.conversationId,
      sourceChannel: "slack",
      externalChatId: "C0123ABCDEF",
      externalThreadId: "1710000000.000100",
    });

    const detail = buildConversationDetailResponse(result.conversationId);

    expect(detail?.conversation.channelBinding).toMatchObject({
      sourceChannel: "slack",
      externalChatId: "C0123ABCDEF",
      externalChatName: "C0123ABCDEF",
      slackChannel: {
        channelId: "C0123ABCDEF",
        name: "C0123ABCDEF",
        link: {
          webUrl: "https://example.slack.com/archives/C0123ABCDEF",
        },
      },
    });
  });

  test("conversation detail omits Slack metadata for non-Slack channels", () => {
    const result = recordInbound("telegram", "tg-chat-1", "msg-1", {
      sourceThreadId: "9001",
    });

    upsertBinding({
      conversationId: result.conversationId,
      sourceChannel: "telegram",
      externalChatId: "tg-chat-1",
      externalChatName: "Family",
      externalThreadId: "9001",
    });

    const detail = buildConversationDetailResponse(result.conversationId);
    const binding = detail?.conversation.channelBinding;

    // The channel-neutral fields pass through for any source channel...
    expect(binding).toMatchObject({
      sourceChannel: "telegram",
      externalChatId: "tg-chat-1",
      externalChatName: "Family",
      externalThreadId: "9001",
    });
    // ...but Slack-only deep-link metadata is not synthesized.
    expect(binding).not.toHaveProperty("slackThread");
    expect(binding).not.toHaveProperty("slackChannel");
  });

  test("binding upsert preserves existing chat name when incoming name is missing", () => {
    const result = recordInbound("slack", "C0123ABCDEF", "msg-1", {
      sourceThreadId: "1710000000.000100",
    });

    upsertBinding({
      conversationId: result.conversationId,
      sourceChannel: "slack",
      externalChatId: "C0123ABCDEF",
      externalChatName: "engineering",
      externalThreadId: "1710000000.000100",
    });
    upsertBinding({
      conversationId: result.conversationId,
      sourceChannel: "slack",
      externalChatId: "C0123ABCDEF",
      externalThreadId: "1710000000.000100",
    });

    expect(
      getBindingByChannelChatThread("slack", "C0123ABCDEF", "1710000000.000100")
        ?.externalChatName,
    ).toBe("engineering");
  });

  test("binding upsert preserves existing chat name when incoming name is blank", () => {
    const result = recordInbound("slack", "C0123ABCDEF", "msg-1", {
      sourceThreadId: "1710000000.000100",
    });

    upsertBinding({
      conversationId: result.conversationId,
      sourceChannel: "slack",
      externalChatId: "C0123ABCDEF",
      externalChatName: "engineering",
      externalThreadId: "1710000000.000100",
    });
    upsertBinding({
      conversationId: result.conversationId,
      sourceChannel: "slack",
      externalChatId: "C0123ABCDEF",
      externalChatName: "   ",
      externalThreadId: "1710000000.000100",
    });

    expect(
      getBindingByChannelChatThread("slack", "C0123ABCDEF", "1710000000.000100")
        ?.externalChatName,
    ).toBe("engineering");
  });

  // ── Deduplication ─────────────────────────────────────────────────

  test("duplicate inbound returns duplicate: true with same eventId", () => {
    const first = recordInbound("telegram", "chat-1", "msg-1");
    const second = recordInbound("telegram", "chat-1", "msg-1");

    expect(second.duplicate).toBe(true);
    expect(second.accepted).toBe(true);
    expect(second.eventId).toBe(first.eventId);
    expect(second.conversationId).toBe(first.conversationId);
  });

  test("same message ID on different chats is not a duplicate", () => {
    const r1 = recordInbound("telegram", "chat-1", "msg-1");
    const r2 = recordInbound("telegram", "chat-2", "msg-1");

    expect(r1.duplicate).toBe(false);
    expect(r2.duplicate).toBe(false);
    expect(r1.eventId).not.toBe(r2.eventId);
  });

  // ── linkMessage + findMessageBySourceId ───────────────────────────

  test("linkMessage sets messageId and findMessageBySourceId retrieves it", () => {
    const result = recordInbound("telegram", "chat-1", "msg-1", {
      sourceMessageId: "src-100",
    });

    const msgId = "internal-msg-abc";
    insertMessage(msgId, result.conversationId);
    linkMessage(result.eventId, msgId);

    const found = findMessageBySourceId("telegram", "chat-1", "src-100");
    expect(found).not.toBeNull();
    expect(found!.messageId).toBe(msgId);
    expect(found!.conversationId).toBe(result.conversationId);
  });

  test("findMessageBySourceId returns null when no match", () => {
    const found = findMessageBySourceId("telegram", "chat-1", "nonexistent");
    expect(found).toBeNull();
  });

  test("findMessageBySourceId returns null when messageId is not linked", () => {
    recordInbound("telegram", "chat-1", "msg-1", {
      sourceMessageId: "src-200",
    });
    // Not calling linkMessage — messageId stays null
    const found = findMessageBySourceId("telegram", "chat-1", "src-200");
    expect(found).toBeNull();
  });

  // ── Delivery status transitions ───────────────────────────────────

  test("acknowledgeDelivery transitions from pending to delivered", () => {
    recordInbound("telegram", "chat-1", "msg-1");

    const ack = acknowledgeDelivery("telegram", "chat-1", "msg-1");
    expect(ack).toBe(true);

    const db = getDb();
    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.externalMessageId, "msg-1"))
      .get();
    expect(row!.deliveryStatus).toBe("delivered");
  });

  test("acknowledgeDelivery accepts late acks after retryable delivery failure", () => {
    const result = recordInbound("telegram", "chat-1", "msg-1");
    markProcessed(result.eventId);
    recordDeliveryFailure(result.eventId, new Error("fetch failed"));

    const ack = acknowledgeDelivery("telegram", "chat-1", "msg-1");
    expect(ack).toBe(true);

    const db = getDb();
    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();
    expect(row!.deliveryStatus).toBe("delivered");
    expect(row!.retryAfter).toBeNull();
  });

  test("acknowledgeDelivery returns false for unknown event", () => {
    const ack = acknowledgeDelivery("telegram", "chat-1", "nonexistent");
    expect(ack).toBe(false);
  });

  test("delivery failures are retryable without changing processing status", () => {
    const result = recordInbound("telegram", "chat-1", "msg-1");
    markProcessed(result.eventId);

    recordDeliveryFailure(result.eventId, new Error("fetch failed"));

    const db = getDb();
    let row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();
    expect(row!.processingStatus).toBe("processed");
    expect(row!.deliveryStatus).toBe("failed");
    expect(row!.processingAttempts).toBe(0);
    expect(row!.deliveryAttempts).toBe(1);
    expect(row!.lastProcessingError).toBe("fetch failed");
    expect(row!.retryAfter).toBeGreaterThan(0);

    db.update(channelInboundEvents)
      .set({ retryAfter: Date.now() - 10_000, deliveredSegmentCount: 2 })
      .where(eq(channelInboundEvents.id, result.eventId))
      .run();

    const retryable = getRetryableDeliveryEvents();
    expect(retryable).toHaveLength(1);
    expect(retryable[0].id).toBe(result.eventId);
    expect(retryable[0].deliveredSegmentCount).toBe(2);

    markDeliveryDelivered(result.eventId);

    row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();
    expect(row!.processingStatus).toBe("processed");
    expect(row!.deliveryStatus).toBe("delivered");
    expect(row!.retryAfter).toBeNull();
    expect(getRetryableDeliveryEvents()).toHaveLength(0);
  });

  test("delivery dead letters are listed and replayed as delivery retries", () => {
    const result = recordInbound("telegram", "chat-1", "msg-1");
    markProcessed(result.eventId);

    recordDeliveryFailure(result.eventId, { status: 400, message: "bad" });

    const deadLetters = getDeadLetterEvents();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].id).toBe(result.eventId);

    const count = replayDeadLetters([result.eventId]);
    expect(count).toBe(1);

    const db = getDb();
    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();
    expect(row!.processingStatus).toBe("processed");
    expect(row!.deliveryStatus).toBe("failed");
    expect(row!.deliveryAttempts).toBe(0);
    expect(row!.lastProcessingError).toBeNull();
    expect(row!.retryAfter).toBeGreaterThan(0);
  });

  // ── Processing status transitions ─────────────────────────────────

  test("markProcessed sets processingStatus to processed", () => {
    const result = recordInbound("telegram", "chat-1", "msg-1");
    markProcessed(result.eventId);

    const db = getDb();
    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();
    expect(row!.processingStatus).toBe("processed");
  });

  test("recordProcessingFailure with retryable error sets status to failed", () => {
    const result = recordInbound("telegram", "chat-1", "msg-1");

    // A timeout error is classified as retryable
    const err = new Error("request timeout");
    recordProcessingFailure(result.eventId, err);

    const db = getDb();
    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();

    expect(row!.processingStatus).toBe("failed");
    expect(row!.processingAttempts).toBe(1);
    expect(row!.lastProcessingError).toBe("request timeout");
    expect(row!.retryAfter).toBeGreaterThan(0);
  });

  test("recordProcessingFailure with fatal error sets status to dead_letter", () => {
    const result = recordInbound("telegram", "chat-1", "msg-1");

    // A 400-status error is classified as fatal
    const err = { status: 400, message: "Bad Request" };
    recordProcessingFailure(result.eventId, err);

    const db = getDb();
    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();

    expect(row!.processingStatus).toBe("dead_letter");
    expect(row!.processingAttempts).toBe(1);
    expect(row!.retryAfter).toBeNull();
  });

  test("recordProcessingFailure dead-letters after max attempts", () => {
    const result = recordInbound("telegram", "chat-1", "msg-1");

    // Exhaust all retry attempts with retryable errors
    const err = new Error("request timeout");
    for (let i = 0; i < RETRY_MAX_ATTEMPTS; i++) {
      recordProcessingFailure(result.eventId, err);
    }

    const db = getDb();
    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();

    expect(row!.processingStatus).toBe("dead_letter");
    expect(row!.processingAttempts).toBe(RETRY_MAX_ATTEMPTS);
  });

  // ── Payload storage ───────────────────────────────────────────────

  test("storePayload persists raw payload and clearPayload removes it", () => {
    const result = recordInbound("telegram", "chat-1", "msg-1");
    const payload = { update_id: 123, message: { text: "hello" } };

    storePayload(result.eventId, payload);

    const db = getDb();
    let row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();
    expect(row!.rawPayload).toBe(JSON.stringify(payload));

    clearPayload(result.eventId);

    row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();
    expect(row!.rawPayload).toBeNull();
  });

  // ── Retryable events query ────────────────────────────────────────

  test("getRetryableEvents returns failed events past their backoff", () => {
    const r1 = recordInbound("telegram", "chat-1", "msg-1");
    const r2 = recordInbound("telegram", "chat-1", "msg-2");
    const _r3 = recordInbound("telegram", "chat-1", "msg-3");

    // r1: failed with past retry_after
    const err = new Error("request timeout");
    recordProcessingFailure(r1.eventId, err);
    // Force retry_after to be in the past
    const db = getDb();
    db.update(channelInboundEvents)
      .set({ retryAfter: Date.now() - 10_000 })
      .where(eq(channelInboundEvents.id, r1.eventId))
      .run();

    // r2: failed but retry_after is in the future
    recordProcessingFailure(r2.eventId, err);
    db.update(channelInboundEvents)
      .set({ retryAfter: Date.now() + 60_000 })
      .where(eq(channelInboundEvents.id, r2.eventId))
      .run();

    // r3: still pending (not failed) — should not appear
    const retryable = getRetryableEvents();
    expect(retryable).toHaveLength(1);
    expect(retryable[0].id).toBe(r1.eventId);
    expect(retryable[0].conversationId).toBe(r1.conversationId);
  });

  test("getRetryableEvents respects limit parameter", () => {
    const db = getDb();
    const err = new Error("request timeout");
    const ids: string[] = [];

    for (let i = 0; i < 5; i++) {
      const r = recordInbound("telegram", "chat-1", `msg-${i}`);
      ids.push(r.eventId);
      recordProcessingFailure(r.eventId, err);
      db.update(channelInboundEvents)
        .set({ retryAfter: Date.now() - 10_000 })
        .where(eq(channelInboundEvents.id, r.eventId))
        .run();
    }

    const retryable = getRetryableEvents(2);
    expect(retryable).toHaveLength(2);
  });

  // ── Dead-letter queue ─────────────────────────────────────────────

  test("getDeadLetterEvents returns dead-lettered events", () => {
    const r1 = recordInbound("telegram", "chat-1", "msg-1");
    const _r2 = recordInbound("telegram", "chat-1", "msg-2");

    // r1: dead-letter via fatal error
    recordProcessingFailure(r1.eventId, { status: 400, message: "invalid" });

    // r2: still pending
    const deadLetters = getDeadLetterEvents();
    expect(deadLetters).toHaveLength(1);
    expect(deadLetters[0].id).toBe(r1.eventId);
    expect(deadLetters[0].sourceChannel).toBe("telegram");
    expect(deadLetters[0].externalChatId).toBe("chat-1");
    expect(deadLetters[0].externalMessageId).toBe("msg-1");
  });

  test("replayDeadLetters resets dead-lettered events to failed for retry", () => {
    const r1 = recordInbound("telegram", "chat-1", "msg-1");
    const r2 = recordInbound("telegram", "chat-1", "msg-2");

    // Dead-letter both
    recordProcessingFailure(r1.eventId, { status: 400, message: "bad" });
    recordProcessingFailure(r2.eventId, { status: 401, message: "auth" });

    const count = replayDeadLetters([r1.eventId, r2.eventId]);
    expect(count).toBe(2);

    const db = getDb();
    const row1 = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, r1.eventId))
      .get();
    const row2 = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, r2.eventId))
      .get();

    expect(row1!.processingStatus).toBe("failed");
    expect(row1!.processingAttempts).toBe(0);
    expect(row1!.lastProcessingError).toBeNull();
    expect(row1!.retryAfter).toBeGreaterThan(0);

    expect(row2!.processingStatus).toBe("failed");
    expect(row2!.processingAttempts).toBe(0);
  });

  test("replayDeadLetters skips non-dead-lettered events", () => {
    const r1 = recordInbound("telegram", "chat-1", "msg-1");

    // r1 is still pending, not dead-lettered
    const count = replayDeadLetters([r1.eventId]);
    expect(count).toBe(0);
  });

  test("replayDeadLetters skips nonexistent IDs", () => {
    const count = replayDeadLetters(["nonexistent-id"]);
    expect(count).toBe(0);
  });

  // ── Full lifecycle ────────────────────────────────────────────────

  test("full lifecycle: inbound -> link -> acknowledge -> processed", () => {
    const result = recordInbound("telegram", "chat-1", "msg-1", {
      sourceMessageId: "src-1",
    });
    expect(result.duplicate).toBe(false);

    const msgId = "internal-msg-1";
    insertMessage(msgId, result.conversationId);
    linkMessage(result.eventId, msgId);
    acknowledgeDelivery("telegram", "chat-1", "msg-1");
    markProcessed(result.eventId);

    const db = getDb();
    const row = db
      .select()
      .from(channelInboundEvents)
      .where(eq(channelInboundEvents.id, result.eventId))
      .get();

    expect(row!.messageId).toBe(msgId);
    expect(row!.deliveryStatus).toBe("delivered");
    expect(row!.processingStatus).toBe("processed");

    const found = findMessageBySourceId("telegram", "chat-1", "src-1");
    expect(found!.messageId).toBe(msgId);
  });

  // ── handleDeleteConversation assistantId parameter ───────────────

  test("handleDeleteConversation deletes scoped key and legacy key for self assistant", async () => {
    // Set up a scoped conversation key like the one created by recordInbound.
    // The handler always uses DAEMON_INTERNAL_ASSISTANT_ID ("self").
    const convId = "conv-delete-test";
    const scopedKey = "asst:self:telegram:chat-del";
    const legacyKey = "telegram:chat-del";

    // Insert a conversation row so FK constraints are satisfied
    const now = Date.now();
    const db = getDb();
    db.insert(conversations)
      .values({
        id: convId,
        title: "test",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    setConversationKey(scopedKey, convId);
    setConversationKey(legacyKey, convId);
    db.insert(externalConversationBindings)
      .values({
        conversationId: convId,
        sourceChannel: "telegram",
        externalChatId: "chat-del",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    // Verify both keys exist
    expect(getConversationByKey(scopedKey)).not.toBeNull();
    expect(getConversationByKey(legacyKey)).not.toBeNull();

    // Call handleDeleteConversation with assistantId as a parameter (not in body)
    const req = new Request("http://localhost/channels/conversation", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "telegram",
        conversationExternalId: "chat-del",
        // Note: no assistantId in the body — it comes from the route param
      }),
    });

    const res = await handleDeleteConversation(req, "my-assistant");
    expect(res.status).toBe(200);

    const json = (await res.json()) as { ok: boolean };
    expect(json.ok).toBe(true);

    // Self delete removes both scoped key and legacy key.
    expect(getConversationByKey(scopedKey)).toBeNull();
    expect(getConversationByKey(legacyKey)).toBeNull();
    // Self delete also removes external bindings.
    const remainingBinding = db
      .select()
      .from(externalConversationBindings)
      .where(eq(externalConversationBindings.conversationId, convId))
      .get();
    expect(remainingBinding).toBeUndefined();
  });

  test('handleDeleteConversation defaults to "self" when no assistantId provided', async () => {
    const convId = "conv-delete-default";
    const scopedKey = "asst:self:telegram:chat-def";
    const legacyKey = "telegram:chat-def";

    const now = Date.now();
    const db = getDb();
    db.insert(conversations)
      .values({
        id: convId,
        title: "test",
        createdAt: now,
        updatedAt: now,
      })
      .run();
    setConversationKey(scopedKey, convId);
    setConversationKey(legacyKey, convId);
    db.insert(externalConversationBindings)
      .values({
        conversationId: convId,
        sourceChannel: "telegram",
        externalChatId: "chat-def",
        createdAt: now,
        updatedAt: now,
      })
      .run();

    const req = new Request("http://localhost/channels/conversation", {
      method: "DELETE",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        sourceChannel: "telegram",
        conversationExternalId: "chat-def",
      }),
    });

    // No assistantId parameter — should default to 'self'
    const res = await handleDeleteConversation(req);
    expect(res.status).toBe(200);

    expect(getConversationByKey(scopedKey)).toBeNull();
    expect(getConversationByKey(legacyKey)).toBeNull();
    // Self delete should keep external bindings in sync for the canonical route.
    const remainingBinding = db
      .select()
      .from(externalConversationBindings)
      .where(eq(externalConversationBindings.conversationId, convId))
      .get();
    expect(remainingBinding).toBeUndefined();
  });
});
