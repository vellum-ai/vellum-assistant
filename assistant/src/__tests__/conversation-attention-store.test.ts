import { beforeEach, describe, expect, test } from "bun:test";

import { eq } from "drizzle-orm";

import {
  getAttentionStateByConversationIds,
  listConversationAttention,
  markConversationUnread,
  projectAssistantMessage,
  recordConversationSeenSignal,
} from "../persistence/conversation-attention-store.js";
import { getDb } from "../persistence/db-connection.js";
import { initializeDb } from "../persistence/db-init.js";
import {
  conversationAssistantAttentionState,
  conversationAttentionEvents,
  conversations,
  messages,
} from "../persistence/schema/index.js";
import {
  pendingOutboxPayloads,
  resetOutboxTable,
  setShareAnalytics,
} from "../telemetry/__tests__/outbox-test-harness.js";
import { buildAssistantResultSeenDaemonEventId } from "../telemetry/assistant-result-seen.js";

await initializeDb();

type AssistantResultSeenPayload = {
  daemon_event_id: string;
  conversation_id: string;
  assistant_message_id: string;
  assistant_message_recorded_at: number;
  signal_type: string;
  confidence: string;
  source_channel: string | null;
  source_interface: string | null;
};

function seenTelemetryPayloads(): AssistantResultSeenPayload[] {
  return pendingOutboxPayloads<AssistantResultSeenPayload>(
    "assistant_result_seen",
  );
}

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
    // recordConversationSeenSignal emits assistant_result_seen telemetry as a
    // side effect; keep the outbox and consent deterministic for every test.
    resetOutboxTable();
    setShareAnalytics(true);
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

    test("returns true when creating new attention state (no prior state)", () => {
      ensureConversation("conv-1");
      const result = projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      expect(result).toBe(true);
    });

    test("returns true when advancing cursor past seen position (seen→unseen)", () => {
      ensureConversation("conv-1");
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
        source: "test",
      });
      const result = projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });
      expect(result).toBe(true);
    });

    test("returns false when conversation is already unseen", () => {
      ensureConversation("conv-1");
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      const result = projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });
      expect(result).toBe(false);
    });

    test("returns false when cursor does not advance (older message)", () => {
      ensureConversation("conv-1");
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-2",
        messageAt: 2000,
      });
      const result = projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      expect(result).toBe(false);
    });

    test("returns false when cursor does not advance (equal timestamp)", () => {
      ensureConversation("conv-1");
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      const result = projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1-dup",
        messageAt: 1000,
      });
      expect(result).toBe(false);
    });

    test("returns true when row exists with null latestAssistantMessageAt (seen signal before first assistant msg)", () => {
      ensureConversation("conv-1");
      // Simulate: user opens conversation before any assistant message,
      // which calls recordConversationSeenSignal and creates a state row
      // with latestAssistantMessageAt = null.
      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "test",
      });
      const states = getAttentionStateByConversationIds(["conv-1"]);
      expect(states.get("conv-1")!.latestAssistantMessageAt).toBeNull();

      // First assistant message should transition to unseen
      const result = projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });
      expect(result).toBe(true);
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
      const { event } = recordConversationSeenSignal({
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

      const { event } = recordConversationSeenSignal({
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

  // ── assistant_result_seen telemetry ──────────────────────────────

  describe("recordConversationSeenSignal — assistant_result_seen telemetry", () => {
    test("emits one event when a seen signal newly covers an assistant message", () => {
      ensureConversation("conv-1");
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      const { event, newlySeenAssistantMessage } = recordConversationSeenSignal(
        {
          conversationId: "conv-1",
          sourceChannel: "vellum",
          signalType: "macos_conversation_opened",
          confidence: "explicit",
          source: "http-api",
        },
      );

      expect(newlySeenAssistantMessage).toEqual({
        id: "msg-1",
        recordedAt: 1000,
      });

      const payloads = seenTelemetryPayloads();
      expect(payloads).toHaveLength(1);
      const payload = payloads[0]!;
      expect(payload.conversation_id).toBe("conv-1");
      expect(payload.assistant_message_id).toBe("msg-1");
      expect(payload.assistant_message_recorded_at).toBe(1000);
      expect(payload.signal_type).toBe("macos_conversation_opened");
      expect(payload.confidence).toBe("explicit");
      expect(payload.source_channel).toBe("vellum");
      expect(payload.source_interface).toBe("http-api");
      // Deterministic id keyed on attention event id + covered message id.
      expect(payload.daemon_event_id).toBe(
        buildAssistantResultSeenDaemonEventId(event.id, "msg-1"),
      );
    });

    test("maps a notification-view signal onto the wire fields", () => {
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
        source: "notification",
      });

      const payloads = seenTelemetryPayloads();
      expect(payloads).toHaveLength(1);
      expect(payloads[0]!.signal_type).toBe("macos_notification_view");
      expect(payloads[0]!.confidence).toBe("inferred");
      expect(payloads[0]!.source_interface).toBe("notification");
    });

    test("emits for a bulk mark-read signal", () => {
      ensureConversation("conv-1");
      projectAssistantMessage({
        conversationId: "conv-1",
        messageId: "msg-1",
        messageAt: 1000,
      });

      recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "web_bulk_mark_read",
        confidence: "explicit",
        source: "http-api",
      });

      const payloads = seenTelemetryPayloads();
      expect(payloads).toHaveLength(1);
      expect(payloads[0]!.signal_type).toBe("web_bulk_mark_read");
    });

    test("emits nothing when there is no assistant message to cover", () => {
      ensureConversation("conv-1");

      const { newlySeenAssistantMessage } = recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "telegram",
        signalType: "telegram_inbound_message",
        confidence: "inferred",
        source: "inbound-message-handler",
      });

      expect(newlySeenAssistantMessage).toBeNull();
      expect(seenTelemetryPayloads()).toHaveLength(0);
    });

    test("a repeated seen signal emits a single event", () => {
      ensureConversation("conv-1");
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
        source: "http-api",
      });
      // Second signal advances nothing (already seen) — no additional event.
      const second = recordConversationSeenSignal({
        conversationId: "conv-1",
        sourceChannel: "vellum",
        signalType: "macos_conversation_opened",
        confidence: "explicit",
        source: "http-api",
      });

      expect(second.newlySeenAssistantMessage).toBeNull();
      expect(seenTelemetryPayloads()).toHaveLength(1);
    });

    test("omits evidence text and attention metadata from the event", () => {
      ensureConversation("conv-1");
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
        source: "http-api",
        evidenceText: "User opened the conversation at 9am",
        metadata: { secretKey: "secretValue" },
      });

      const payloads = seenTelemetryPayloads();
      expect(payloads).toHaveLength(1);
      const keys = Object.keys(payloads[0]!);
      expect(keys).not.toContain("evidence_text");
      expect(keys).not.toContain("evidenceText");
      expect(keys).not.toContain("metadata");
      expect(keys).not.toContain("metadata_json");
      expect(JSON.stringify(payloads[0])).not.toContain("secretValue");
      expect(JSON.stringify(payloads[0])).not.toContain(
        "User opened the conversation",
      );
    });

    test("emits nothing when analytics consent is opted out, but still records the seen signal", () => {
      setShareAnalytics(false);
      ensureConversation("conv-1");
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
        source: "http-api",
      });

      expect(seenTelemetryPayloads()).toHaveLength(0);
      // The seen signal itself is unaffected by telemetry consent.
      const state = getAttentionStateByConversationIds(["conv-1"]).get(
        "conv-1",
      )!;
      expect(state.lastSeenAssistantMessageId).toBe("msg-1");
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
