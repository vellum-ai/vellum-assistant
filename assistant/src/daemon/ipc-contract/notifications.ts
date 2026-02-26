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

/** Client reports a direct delivery interaction (view, dismiss, etc). */
export interface NotificationDeliveryInteraction {
  type: 'notification_delivery_interaction';
  deliveryId: string;
  interactionType: string;
  confidence: string;
  source: string;
  evidenceText?: string;
  occurredAt?: number;
}

/** Client reports explicit conversation view (sidebar selection or deep-link). */
export interface NotificationConversationViewed {
  type: 'notification_conversation_viewed';
  conversationId: string;
  source: string;
  evidenceText?: string;
  occurredAt?: number;
}

// --- Domain-level union aliases (consumed by the barrel file) ---

export type _NotificationsClientMessages =
  | NotificationIntentResult
  | NotificationDeliveryInteraction
  | NotificationConversationViewed;

export type _NotificationsServerMessages = NotificationIntent | NotificationThreadCreated;
