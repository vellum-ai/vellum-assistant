import { beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
  truncateForLog: (value: string) => value,
}));

import { eq } from "drizzle-orm";

import {
  getAttentionStateByConversationIds,
  listConversationAttention,
  markConversationUnread,
  projectAssistantMessage,
  recordConversationSeenSignal,
} from "../memory/conversation-attention-store.js";
import { getDb, initializeDb } from "../memory/db.js";
import {
  conversationAssistantAttentionState,
  conversationAttentionEvents,
  conversations,
  messages,
} from "../memory/schema.js";

initializeDb();

function ensureConversation(id: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversations)
    .values({
      id,
      title: `Conversation ${id}`,
      createdAt: now,
      updatedAt: now,
    })
    .run();
}

function clearTables(): void {
  const db = getDb();
  db.delete(conversationAttentionEvents).run();
  db.delete(conversationAssistantAttentionState).run();
  db.delete(messages).run();
  db.delete(conversations).run();
}

function insertAssistantMessage(
  conversationId: string,
  messageId: string,
  createdAt: number,
): void {
  const db = getDb();
  db.insert(messages)
    .values({
      id: messageId,
      conversationId,
      role: "assistant",
      content: `Assistant message ${messageId}`,
      createdAt,
      metadata: null,
    })
    .run();
}

describe("conversation-attention-store", () => {
  beforeEach(() => {
    clearTables();
  });

  // ── projectAssistantMessage ─────────────────────────────────────

  describe("projectAssistantMessage", () => {
    test("creates a new state row when none exists", () => {
      ensureConversation("conv-1");
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      const states = getAttentionStateByConversationIds(["conv-1"]);
      expect(states.size).toBe(1);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-1");
      expect(state.latestAssistantMessageAt).toBe(1000);
      expect(state.lastSeenAssistantMessageId).toBeNull();
      expect(state.lastSeenAssistantMessageAt).toBeNull();
    });

    test("advances cursor when new message is later", () => {
      ensureConversation("conv-1");
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });

      const states = getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-2");
      expect(state.latestAssistantMessageAt).toBe(2000);
    });

    test("does not move cursor backward (monotonic invariant)", () => {
      ensureConversation("conv-1");
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      const states = getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-2");
      expect(state.latestAssistantMessageAt).toBe(2000);
    });

    test("does not advance cursor when timestamp is equal", () => {
      ensureConversation("conv-1");
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1-dup",
        messageAt: 1000,
      });

      const states = getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-1");
    });
  });

  // ── recordConversationSeenSignal ────────────────────────────────

  describe("recordConversationSeenSignal", () => {
    test("preserves iOS conversation-opened provenance", () => {
      ensureConversation("conv-1");
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "ios_conversation_opened",
        confidence: "explicit",
        source: "ios-client",
      });

      const states = getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.lastSeenSignalType).toBe("ios_conversation_opened");
      expect(state.lastSeenAssistantMessageId).toBe("msg-1");
    });

    test("appends an immutable event row", () => {
      ensureConversation("conv-1");
      const event = recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      expect(event.id).toBeTruthy();
      expect(event.conversationId).toBe("conv-1");
      expect(event.signalType).toBe("macos_conversation_opened");
      expect(event.confidence).toBe("explicit");
    });

    test("advances seen cursor to current latest assistant message", () => {
      ensureConversation("conv-1");

      // Project an assistant message first
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      // Now record a seen signal
      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      const states = getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.lastSeenAssistantMessageId).toBe("msg-1");
      expect(state.lastSeenAssistantMessageAt).toBe(1000);
    });

    test("creates state row if none exists when recording seen signal", () => {
      ensureConversation("conv-1");

      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "telegram",
        signalType: "telegram_inbound_message",
        confidence: "inferred",
        source: "telegram-gateway",
      });

      const states = getAttentionStateByConversationIds(["conv-1"]);
      expect(states.size).toBe(1);
      const state = states.get("conv-1")!;
      // No latest assistant message to mark as seen
      expect(state.lastSeenAssistantMessageId).toBeNull();
      expect(state.lastSeenSignalType).toBe("telegram_inbound_message");
    });

    test("does not regress seen cursor (monotonic invariant)", () => {
      ensureConversation("conv-1");

      // Project two assistant messages
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      // Mark as seen at msg-1
      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      // Project a second message
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });

      // Mark as seen at msg-2
      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      const states = getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.lastSeenAssistantMessageId).toBe("msg-2");
      expect(state.lastSeenAssistantMessageAt).toBe(2000);
    });

    test("records evidence text and metadata in event", () => {
      ensureConversation("conv-1");

      const event = recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "telegram",
        signalType: "telegram_callback",
        confidence: "explicit",
        source: "telegram-gateway",
        evidenceText: "User pressed inline button",
        metadata: { callbackData: "ack:123" },
      });

      expect(event.evidenceText).toBe("User pressed inline button");
      expect(JSON.parse(event.metadataJson)).toEqual({
        callbackData: "ack:123",
      });
    });

    test("seen signal with no latest assistant message does not set seen cursor", () => {
      ensureConversation("conv-1");

      // Record seen signal without any assistant message
      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_notification_view",
        confidence: "inferred",
        source: "desktop-client",
      });

      const states = getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.lastSeenAssistantMessageId).toBeNull();
      expect(state.lastSeenAssistantMessageAt).toBeNull();
      expect(state.lastSeenSignalType).toBe("macos_notification_view");
    });

    test("already-seen conversation does not regress on additional seen signal", () => {
      ensureConversation("conv-1");

      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      // Mark as seen
      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      // Record another seen signal (should not regress)
      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "telegram",
        signalType: "telegram_inbound_message",
        confidence: "inferred",
        source: "telegram-gateway",
      });

      const states = getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      // Seen cursor should still point to msg-1
      expect(state.lastSeenAssistantMessageId).toBe("msg-1");
      expect(state.lastSeenAssistantMessageAt).toBe(1000);
      // Signal metadata should reflect the latest signal
      expect(state.lastSeenSignalType).toBe("telegram_inbound_message");
    });
  });

  // ── markConversationUnread ───────────────────────────────────────

  describe("markConversationUnread", () => {
    test("rewinds the seen cursor to null when the latest assistant message is the first one", () => {
      ensureConversation("conv-1");
      insertAssistantMessage("conv-1", "msg-1", 1000);
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      markConversationUnread("conv-1");

      const states = getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-1");
      expect(state.lastSeenAssistantMessageId).toBeNull();
      expect(state.lastSeenAssistantMessageAt).toBeNull();
      expect(
        listConversationAttention({ state: "unseen" }).map(
          (entry) => entry.conversationId,
        ),
      ).toEqual(["conv-1"]);
    });

    test("rewinds the seen cursor to the prior assistant message", () => {
      ensureConversation("conv-1");
      insertAssistantMessage("conv-1", "msg-1", 1000);
      insertAssistantMessage("conv-1", "msg-2", 2000);
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });
      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      markConversationUnread("conv-1");

      const states = getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-2");
      expect(state.latestAssistantMessageAt).toBe(2000);
      expect(state.lastSeenAssistantMessageId).toBe("msg-1");
      expect(state.lastSeenAssistantMessageAt).toBe(1000);
    });

    test("bootstraps unread rewind to a strictly older assistant timestamp", () => {
      ensureConversation("conv-1");
      insertAssistantMessage("conv-1", "msg-1", 1000);
      insertAssistantMessage("conv-1", "msg-2", 2000);
      insertAssistantMessage("conv-1", "msg-3", 2000);

      markConversationUnread("conv-1");

      const states = getAttentionStateByConversationIds(["conv-1"]);
      const state = states.get("conv-1")!;
      expect(state.latestAssistantMessageId).toBe("msg-3");
      expect(state.latestAssistantMessageAt).toBe(2000);
      expect(state.lastSeenAssistantMessageId).toBe("msg-1");
      expect(state.lastSeenAssistantMessageAt).toBe(1000);
      expect(
        listConversationAttention({ state: "unseen" }).map(
          (entry) => entry.conversationId,
        ),
      ).toEqual(["conv-1"]);
    });

    test("is idempotent when the conversation is already unread", () => {
      ensureConversation("conv-1");
      insertAssistantMessage("conv-1", "msg-1", 1000);
      insertAssistantMessage("conv-1", "msg-2", 2000);
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });
      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      markConversationUnread("conv-1");
      const onceUnread = getAttentionStateByConversationIds(["conv-1"]).get(
        "conv-1",
      )!;

      markConversationUnread("conv-1");

      const twiceUnread = getAttentionStateByConversationIds(["conv-1"]).get(
        "conv-1",
      )!;
      expect(twiceUnread.lastSeenAssistantMessageId).toBe(
        onceUnread.lastSeenAssistantMessageId,
      );
      expect(twiceUnread.lastSeenAssistantMessageAt).toBe(
        onceUnread.lastSeenAssistantMessageAt,
      );
    });

    test("rejects conversations with no assistant message", () => {
      ensureConversation("conv-1");

      expect(() => markConversationUnread("conv-1")).toThrow(
        "Conversation has no assistant message to mark unread",
      );
    });
  });

  // ── getAttentionStateByConversationIds ──────────────────────────

  describe("getAttentionStateByConversationIds", () => {
    test("returns empty map for empty input", () => {
      const result = getAttentionStateByConversationIds([]);
      expect(result.size).toBe(0);
    });

    test("returns states for multiple conversations", () => {
      ensureConversation("conv-1");
      ensureConversation("conv-2");

      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 2000,
      });

      const result = getAttentionStateByConversationIds(["conv-1", "conv-2"]);
      expect(result.size).toBe(2);
      expect(result.get("conv-1")!.latestAssistantMessageId).toBe("msg-1");
      expect(result.get("conv-2")!.latestAssistantMessageId).toBe("msg-2");
    });

    test("omits conversations without state", () => {
      ensureConversation("conv-1");
      ensureConversation("conv-2");

      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      const result = getAttentionStateByConversationIds(["conv-1", "conv-2"]);
      expect(result.size).toBe(1);
      expect(result.has("conv-1")).toBe(true);
      expect(result.has("conv-2")).toBe(false);
    });
  });

  // ── listConversationAttention ───────────────────────────────────

  describe("listConversationAttention", () => {
    test("returns all states for an assistant", () => {
      ensureConversation("conv-1");
      ensureConversation("conv-2");

      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 2000,
      });

      const result = listConversationAttention({});
      expect(result).toHaveLength(2);
    });

    test("filters by unseen state", () => {
      ensureConversation("conv-1");
      ensureConversation("conv-2");

      // conv-1: has assistant message, not seen
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      // conv-2: has assistant message, seen
      projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 2000,
      });
      recordConversationSeenSignal({
        conversationId: "conv-2",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      const unseen = listConversationAttention({
        state: "unseen",
      });
      expect(unseen).toHaveLength(1);
      expect(unseen[0].conversationId).toBe("conv-1");
    });

    test("filters by seen state", () => {
      ensureConversation("conv-1");
      ensureConversation("conv-2");

      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 2000,
      });
      recordConversationSeenSignal({
        conversationId: "conv-2",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      const seen = listConversationAttention({
        state: "seen",
      });
      expect(seen).toHaveLength(1);
      expect(seen[0].conversationId).toBe("conv-2");
    });

    test("respects limit parameter", () => {
      ensureConversation("conv-1");
      ensureConversation("conv-2");
      ensureConversation("conv-3");

      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 2000,
      });
      projectAssistantMessage({
        conversationId: "conv-3",
        messageId: "msg-3",
        messageAt: 3000,
      });

      const result = listConversationAttention({
        limit: 2,
      });
      expect(result).toHaveLength(2);
    });

    test("orders by latest assistant message descending", () => {
      ensureConversation("conv-1");
      ensureConversation("conv-2");
      ensureConversation("conv-3");

      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 3000,
      });
      projectAssistantMessage({
        conversationId: "conv-3",
        messageId: "msg-3",
        messageAt: 2000,
      });

      const result = listConversationAttention({});
      expect(result[0].conversationId).toBe("conv-2");
      expect(result[1].conversationId).toBe("conv-3");
      expect(result[2].conversationId).toBe("conv-1");
    });

    test("before cursor filters out newer conversations", () => {
      ensureConversation("conv-1");
      ensureConversation("conv-2");
      ensureConversation("conv-3");

      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      projectAssistantMessage({
        conversationId: "conv-2",
        messageId: "msg-2",
        messageAt: 2000,
      });
      projectAssistantMessage({
        conversationId: "conv-3",
        messageId: "msg-3",
        messageAt: 3000,
      });

      const result = listConversationAttention({
        before: 2500,
      });
      expect(result).toHaveLength(2);
      expect(result[0].conversationId).toBe("conv-2");
      expect(result[1].conversationId).toBe("conv-1");
    });
  });

  // ── Evidence immutability ───────────────────────────────────────

  describe("evidence immutability", () => {
    test("multiple seen signals append separate event rows", () => {
      ensureConversation("conv-1");

      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_notification_view",
        confidence: "inferred",
        source: "desktop-client",
      });

      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "desktop-client",
      });

      const db = getDb();
      const events = db
        .select()
        .from(conversationAttentionEvents)
        .where(eq(conversationAttentionEvents.conversationId, "conv-1"))
        .all();

      expect(events).toHaveLength(2);
      expect(events[0].signalType).not.toBe(events[1].signalType);
    });
  });
});
