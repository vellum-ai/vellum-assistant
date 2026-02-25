/** Broadcast to connected macOS clients when a notification should be displayed. */
export interface NotificationIntent {
  type: 'notification_intent';
  sourceEventName: string;
  title: string;
  body: string;
  /** Optional deep-link metadata so the client can navigate to the relevant context. */
  deepLinkMetadata?: Record<string, unknown>;
}

// --- Domain-level union aliases (consumed by the barrel file) ---
// Notifications has no client messages.

export type _NotificationsServerMessages = NotificationIntent;
