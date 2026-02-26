/** Broadcast to connected macOS clients when a notification should be displayed. */
export interface NotificationIntent {
  type: 'notification_intent';
  /** Delivery audit record ID so the client can correlate ack messages. */
  deliveryId?: string;
  sourceEventName: string;
  title: string;
  body: string;
  /** Optional deep-link metadata so the client can navigate to the relevant context. */
  deepLinkMetadata?: Record<string, unknown>;
}

/** Server push — broadcast when a notification creates a new vellum conversation thread. */
export interface NotificationThreadCreated {
  type: 'notification_thread_created';
  conversationId: string;
  title: string;
  sourceEventName: string;
}

/** Client ack sent after UNUserNotificationCenter.add() completes (or fails). */
export interface NotificationIntentResult {
  type: 'notification_intent_result';
  deliveryId: string;
  success: boolean;
  errorMessage?: string;
  errorCode?: string;
}

/** Client signal indicating the user has seen a conversation (e.g. opened it or clicked a notification). */
export interface ConversationSeenSignal {
  type: 'conversation_seen_signal';
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

export type _NotificationsClientMessages = NotificationIntentResult | ConversationSeenSignal;

export type _NotificationsServerMessages = NotificationIntent | NotificationThreadCreated;
