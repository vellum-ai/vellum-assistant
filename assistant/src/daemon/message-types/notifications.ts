/** Broadcast to connected macOS clients when a notification should be displayed. */
export interface NotificationIntent {
  type: "notification_intent";
  /** Delivery audit record ID so the client can correlate ack messages. */
  deliveryId?: string;
  sourceEventName: string;
  title: string;
  body: string;
  /** Optional deep-link metadata so the client can navigate to the relevant context. */
  deepLinkMetadata?: Record<string, unknown>;
  /**
   * When set, this notification is guardian-sensitive and should only be
   * displayed by clients whose guardian identity matches this principal ID.
   * Clients not bound to this guardian should ignore the notification.
   */
  targetGuardianPrincipalId?: string;
}

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
   * Schedule job identifier propagated from the signal producer.
   * Clients use this to sub-group conversations under the same schedule
   * execution in the sidebar.
   */
  scheduleJobId?: string;
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
  | NotificationIntent
  | NotificationConversationCreated;
