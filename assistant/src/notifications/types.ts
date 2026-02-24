/**
 * Core domain types for the unified notification system.
 */

// All notification event types the system can emit.
export enum NotificationType {
  ReminderFired = 'reminder_fired',
  ScheduleComplete = 'schedule_complete',
  GuardianQuestionRequiredAction = 'guardian_question_required_action',
  IngressEscalationRequiredAction = 'ingress_escalation_required_action',
  ToolConfirmationRequiredAction = 'tool_confirmation_required_action',
  ActivityComplete = 'activity_complete',
  QuickChatResponseReady = 'quick_chat_response_ready',
  VoiceResponseReady = 'voice_response_ready',
  RideShotgunInvitation = 'ride_shotgun_invitation',
}

// Whether a notification should stay on the originating device or fan out cross-channel.
export enum NotificationDeliveryClass {
  LocalOnly = 'local_only',
  CrossChannelEligible = 'cross_channel_eligible',
}

/** Maps each notification type to its default delivery class. */
export const NOTIFICATION_DELIVERY_CLASS_MAP: Record<NotificationType, NotificationDeliveryClass> = {
  [NotificationType.ReminderFired]: NotificationDeliveryClass.CrossChannelEligible,
  [NotificationType.ScheduleComplete]: NotificationDeliveryClass.CrossChannelEligible,
  [NotificationType.GuardianQuestionRequiredAction]: NotificationDeliveryClass.CrossChannelEligible,
  [NotificationType.IngressEscalationRequiredAction]: NotificationDeliveryClass.CrossChannelEligible,
  [NotificationType.ToolConfirmationRequiredAction]: NotificationDeliveryClass.CrossChannelEligible,
  [NotificationType.ActivityComplete]: NotificationDeliveryClass.CrossChannelEligible,
  [NotificationType.QuickChatResponseReady]: NotificationDeliveryClass.LocalOnly,
  [NotificationType.VoiceResponseReady]: NotificationDeliveryClass.LocalOnly,
  [NotificationType.RideShotgunInvitation]: NotificationDeliveryClass.LocalOnly,
};

export type NotificationChannel = 'macos' | 'telegram';

export type NotificationPriority = 'low' | 'normal' | 'high' | 'critical';

/** Envelope wrapping a single notification event through the delivery pipeline. */
export interface NotificationEnvelope {
  id: string;
  assistantId: string;
  type: NotificationType;
  deliveryClass: NotificationDeliveryClass;
  priority: NotificationPriority;
  requiresAction: boolean;
  sourceChannel: NotificationChannel;
  sourceSessionId: string;
  sourceEventId: string;
  payload: Record<string, unknown>;
  dedupeKey?: string;
  createdAt: number;
}

export type NotificationDeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

/** Result of attempting to deliver a notification to a single channel. */
export interface NotificationDeliveryResult {
  channel: NotificationChannel;
  destination: string;
  status: NotificationDeliveryStatus;
  errorCode?: string;
  errorMessage?: string;
  sentAt?: number;
}
