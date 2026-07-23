import type { NotificationConversationCreatedEvent } from "../../api/events/notification-conversation-created.js";
import type { NotificationIntentEvent } from "../../api/events/notification-intent.js";

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
  | NotificationConversationCreatedEvent;
