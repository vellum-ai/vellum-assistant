/**
 * Tests for handleListMessages surfacing the in-memory message queue.
 *
 * Messages enqueued while the agent is mid-turn live only in the live
 * conversation's in-memory queue until the queue drains and persists them.
 * The messages snapshot appends them (carrying `queueStatus: "queued"` and a
 * 1-based `queuePosition`, mirroring the client `DisplayMessage` shape) to the
 * newest page so a cold reload restores the queued rows that the
 * `message_queued` SSE events would otherwise be the only source of.
 */

import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

mock.module("../config/loader.js", () => ({
  getConfig: () => ({
    ui: {},
    model: "test",
    provider: "test",
    memory: { enabled: false },
    rateLimit: { maxRequestsPerMinute: 0 },
  }),
}));

import type { Conversation } from "../daemon/conversation.js";
import type { QueuedMessage } from "../daemon/conversation-queue-manager.js";
import {
  clearConversations,
  setConversation,
} from "../daemon/conversation-registry.js";
import {
  addMessage,
  createConversation,
} from "../persistence/conversation-crud.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import { handleListMessages } from "../runtime/routes/conversation-routes.js";

await initializeDb();

function resetTables() {
  const db = getDb();
  db.run("DELETE FROM messages");
  db.run("DELETE FROM conversations");
  clearConversations();
}

interface MessagePayload {
  id: string;
  role: string;
  content?: string;
  clientMessageId?: string;
  queueStatus?: "queued" | "processing";
  queuePosition?: number;
  attachments?: Array<{ id: string; filename: string; kind: string }>;
}

/** Register a live conversation whose in-memory queue holds `queued`. */
function registerLiveConversation(
  conversationId: string,
  queued: QueuedMessage[],
): void {
  const stub = {
    snapshotQueuedMessages: () => queued,
    // A conversation only holds a queue while it is mid-turn; mirror that so
    // `isConversationProcessing` (which prefers the live instance) reports busy.
    isProcessing: () => true,
  } as unknown as Conversation;
  setConversation(conversationId, stub);
}

function makeQueued(overrides: Partial<QueuedMessage>): QueuedMessage {
  return {
    content: "queued body",
    attachments: [],
    requestId: "req-1",
    onEvent: () => {},
    sentAt: 1_700_000_000_000,
    ...overrides,
  } as QueuedMessage;
}

describe("handleListMessages in-memory queue", () => {
  beforeEach(resetTables);

  test("appends queued rows in FIFO order with 1-based queuePosition", async () => {
    // GIVEN a persisted user turn and two messages still waiting in the queue
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "first" }]),
      { skipIndexing: true },
    );
    registerLiveConversation(conv.id, [
      makeQueued({
        requestId: "req-queued-1",
        content: "please also do this",
        clientMessageId: "nonce-queued",
      }),
      makeQueued({ requestId: "req-queued-2", content: "and then this" }),
    ]);

    // WHEN the messages snapshot is built for the newest page
    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    // THEN the queued messages are appended after the persisted row, carrying
    // queue state and keyed by their requestId for the delete/steer endpoints
    expect(body.messages).toHaveLength(3);
    expect(body.messages[0].queueStatus).toBeUndefined();

    const first = body.messages[1];
    expect(first.queueStatus).toBe("queued");
    expect(first.queuePosition).toBe(1);
    expect(first.role).toBe("user");
    expect(first.id).toBe("req-queued-1");
    expect(first.content).toBe("please also do this");
    expect(first.clientMessageId).toBe("nonce-queued");

    const second = body.messages[2];
    expect(second.queueStatus).toBe("queued");
    expect(second.queuePosition).toBe(2);
    expect(second.id).toBe("req-queued-2");
  });

  test("prefers displayContent over the model-facing content", async () => {
    const conv = createConversation();
    registerLiveConversation(conv.id, [
      makeQueued({
        requestId: "req-display",
        content: "stripped recording intent",
        displayContent: "what the user actually typed",
      }),
    ]);

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].content).toBe("what the user actually typed");
  });

  test("renders queued attachments with a derived kind", async () => {
    const conv = createConversation();
    registerLiveConversation(conv.id, [
      makeQueued({
        requestId: "req-att",
        content: "see attached",
        attachments: [
          {
            filename: "diagram.png",
            mimeType: "image/png",
            data: "AAAA",
          },
        ],
      }),
    ]);

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    const att = body.messages[0].attachments?.[0];
    expect(att?.filename).toBe("diagram.png");
    expect(att?.kind).toBe("image");
    expect(att?.id).toBe("req-att:attachment:0");
  });

  test("filters hidden queued messages from the snapshot, keeping positions contiguous", async () => {
    // A hidden send (e.g. the channel-setup wizard-close marker) that queued
    // behind an in-flight turn must not surface as a queued bubble on a
    // reload/reconnect fetch; visible siblings keep 1-based positions.
    const conv = createConversation();
    registerLiveConversation(conv.id, [
      makeQueued({
        requestId: "req-hidden",
        content:
          "[User action on channel_setup surface: closed the slack setup wizard]",
        metadata: { hidden: true },
      }),
      makeQueued({ requestId: "req-visible", content: "a real message" }),
    ]);

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].id).toBe("req-visible");
    expect(body.messages[0].queuePosition).toBe(1);
  });

  test("does not append queued messages to an older-history page", async () => {
    // GIVEN history requested with beforeTimestamp (older page)
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "old" }]),
      { skipIndexing: true },
    );
    registerLiveConversation(conv.id, [makeQueued({ requestId: "req-old" })]);

    // WHEN paging older history
    const response = handleListMessages({
      queryParams: {
        conversationId: conv.id,
        beforeTimestamp: String(Date.now() + 1_000),
      },
    });
    const body = response as { messages: MessagePayload[] };

    // THEN the queued message is not mixed into the older page
    expect(body.messages.every((m) => m.queueStatus == null)).toBe(true);
  });

  test("returns only persisted rows when the conversation is not live", async () => {
    // GIVEN a conversation with no live in-memory instance (cold / aged out)
    const conv = createConversation();
    await addMessage(
      conv.id,
      "user",
      JSON.stringify([{ type: "text", text: "only persisted" }]),
      { skipIndexing: true },
    );

    const response = handleListMessages({
      queryParams: { conversationId: conv.id },
    });
    const body = response as { messages: MessagePayload[] };

    expect(body.messages).toHaveLength(1);
    expect(body.messages[0].queueStatus).toBeUndefined();
  });
});
