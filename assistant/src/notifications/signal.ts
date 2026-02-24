/**
 * NotificationSignal -- the flexible input from producers.
 * Replaces the old rigid NotificationType enum with free-form event names
 * and structured attention hints that let the decision engine route contextually.
 */

export interface AttentionHints {
  requiresAction: boolean;
  urgency: 'low' | 'medium' | 'high';
  deadlineAt?: number; // epoch ms
  isAsyncBackground: boolean;
  visibleInSourceNow: boolean;
}

export interface NotificationSignal {
  signalId: string;
  assistantId: string;
  createdAt: number; // epoch ms
  sourceChannel: string; // free-form: 'macos', 'telegram', 'voice', 'scheduler', etc.
  sourceSessionId: string;
  sourceEventName: string; // free-form: 'reminder_fired', 'schedule_complete', 'guardian_question', etc.
  contextPayload: Record<string, unknown>;
  attentionHints: AttentionHints;
}
