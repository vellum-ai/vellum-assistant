import { afterAll, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import { eq } from "drizzle-orm";

import {
  getConversationByKey,
  setConversationKey,
} from "../memory/conversation-key-store.js";
import { getDb, initializeDb, resetDb } from "../memory/db.js";
import {
  clearPayload,
  findMessageBySourceId,
  linkMessage,
  recordInbound,
  storePayload,
} from "../memory/delivery-crud.js";
import {
  acknowledgeDelivery,
  getDeadLetterEvents,
  getRetryableEvents,
  markProcessed,
  recordProcessingFailure,
  replayDeadLetters,
} from "../memory/delivery-status.js";
import { RETRY_MAX_ATTEMPTS } from "../memory/job-utils.js";
import {
  channelInboundEvents,
  conversations,
  externalConversationBindings,
  messages,
} from "../memory/schema.js";
import { handleDeleteConversation } from "../runtime/routes/channel-routes.js";

initializeDb();

afterAll(() => {
  resetDb();
});

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM channel_inbound_events");
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversation_keys");
  db.run("DELETE FROM conversations");
}

/** Insert a message row so FK constraints on channel_inbound_events.message_id pass. */
function insertMessage(id: string, conversationId: string): void {
  const db = getDb();
  db.insert(messages)
    .values({
      id,
      conversationId,
      role: "user",
      content: "test message",
      createdAt: Date.now(),
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

  test("acknowledgeDelivery returns false for unknown event", () => {
    const ack = acknowledgeDelivery("telegram", "chat-1", "nonexistent");
    expect(ack).toBe(false);
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

  test("handleDeleteConversation with non-self assistant deletes only scoped key", async () => {
    // Set up a scoped conversation key like the one created by recordInbound
    // with a specific assistantId.
    const convId = "conv-delete-test";
    const scopedKey = "asst:my-assistant:telegram:chat-del";
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

    // Non-self delete should only remove the scoped key and preserve legacy.
    expect(getConversationByKey(scopedKey)).toBeNull();
    expect(getConversationByKey(legacyKey)).not.toBeNull();
    // Non-self delete should not mutate assistant-agnostic external bindings.
    const remainingBinding = db
      .select()
      .from(externalConversationBindings)
      .where(eq(externalConversationBindings.conversationId, convId))
      .get();
    expect(remainingBinding).not.toBeNull();
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
