// TODO: port from platform

interface NotificationPayload {
  title: string;
  body: string;
  sourceEventName?: string;
  deliveryId?: string;
  deepLinkMetadata?: Record<string, unknown>;
  assistantId?: string;
}

export function extractConversationKey(_deepLinkMetadata: unknown): string | null { return null; }
export function postLocalNotification(_payload: NotificationPayload) {}
export function sendNotificationIntentAck(_assistantId: string, _deliveryId: string, _handled: boolean) {}
