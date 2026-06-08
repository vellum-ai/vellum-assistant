import type { NotificationIntentEvent } from "../../api/events/notification-intent.js";

/** Server push — broadcast when a notification creates a new vellum conversation. */
export interface NotificationConversationCreated {
  type: "notification_conversation_created";
  conversationId: string;
  title: string;
  sourceEventName: string;
  /**
   * When set, this conversation was created for a guardian-sensitive notification
   * and should only be surfaced by clients bound to this guardian identity.
   */
  targetGuardianPrincipalId?: string;
  /**
   * Conversation group identifier propagated from the signal producer.
   * Clients use this to place the conversation in the correct sidebar folder
   * (e.g. "system:scheduled" for schedule completion threads).
   */
  groupId?: string;
  /**
   * Semantic source of the conversation (e.g. "schedule", "reminder").
   * Allows clients to override the default "notification" source so the
   * conversation is attributed correctly.
   */
  source?: string;
  /**
   * Mirrors `NotificationIntent.silent`. When true the client must not
   * post a fallback OS banner for this conversation — the sidebar entry
   * still appears, but the always-on inbox is the only surfaced channel.
   * Derived from the originating signal's `attentionHints.urgency`.
   */
  silent?: boolean;
}

/** Client ack sent after UNUserNotificationCenter.add() completes (or fails). */
export interface NotificationIntentResult {
  type: "notification_intent_result";
  deliveryId: string;
  success: boolean;
  errorMessage?: string;
  errorCode?: string;
}

/** Client signal indicating the user has seen a conversation (e.g. opened it or clicked a notification). */
export interface ConversationSeenSignal {
  type: "conversation_seen_signal";
  conversationId: string;
  sourceChannel: string;
  signalType: string;
  confidence: string;
  source: string;
  evidenceText?: string;
  observedAt?: number;
  metadata?: Record<string, unknown>;
}

/** Client signal indicating the user wants a conversation marked unread again. */
export interface ConversationUnreadSignal {
  type: "conversation_unread_signal";
  conversationId: string;
  sourceChannel: string;
  signalType: string;
  confidence: string;
  source: string;
  evidenceText?: string;
  observedAt?: number;
  metadata?: Record<string, unknown>;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _NotificationsClientMessages =
  | NotificationIntentResult
  | ConversationSeenSignal
  | ConversationUnreadSignal;

export type _NotificationsServerMessages =
  | NotificationIntentEvent
  | NotificationConversationCreated;
