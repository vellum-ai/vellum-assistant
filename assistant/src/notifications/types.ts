/**
 * Core domain types for the unified notification system.
 *
 * Defines the channel-adapter interfaces that the broadcaster and adapters
 * depend on, plus the decision engine output contract.
 */

import type { ChannelId } from '../channels/types.js';
import type { ChannelPolicies } from '../channels/config.js';

/**
 * Derived from the channel policy registry: only channels whose
 * deliveryEnabled flag is true are valid notification channels.
 */
export type NotificationChannel = {
  [K in keyof ChannelPolicies]: ChannelPolicies[K]['notification']['deliveryEnabled'] extends true ? K : never;
}[keyof ChannelPolicies] & ChannelId;

export type NotificationDeliveryStatus = 'pending' | 'sent' | 'failed' | 'skipped';

/** Result of attempting to deliver a notification to a single channel. */
export interface NotificationDeliveryResult {
  channel: NotificationChannel;
  destination: string;
  status: NotificationDeliveryStatus;
  errorCode?: string;
  errorMessage?: string;
  sentAt?: number;
  conversationId?: string;
  messageId?: string;
  conversationStrategy?: string;
}

// -- Channel adapter interfaces -----------------------------------------------

/** Result returned by a channel adapter after attempting to send. */
export interface DeliveryResult {
  success: boolean;
  error?: string;
}

/** Resolved destination for a specific channel. */
export interface ChannelDestination {
  channel: NotificationChannel;
  endpoint?: string;
  metadata?: Record<string, unknown>;
}

/**
 * Delivery payload assembled from the decision engine's rendered copy
 * plus contextual fields the adapters need for formatting and routing.
 */
export interface ChannelDeliveryPayload {
  /** Delivery audit record ID — passed through to the client for ack correlation. */
  deliveryId?: string;
  sourceEventName: string;
  copy: RenderedChannelCopy;
  deepLinkTarget?: Record<string, unknown>;
}

/** Interface that each channel adapter must implement. */
export interface ChannelAdapter {
  channel: NotificationChannel;
  send(payload: ChannelDeliveryPayload, destination: ChannelDestination): Promise<DeliveryResult>;
}

// -- Decision engine output ---------------------------------------------------

/** Rendered notification copy for a single channel. */
export interface RenderedChannelCopy {
  title: string;
  body: string;
  threadTitle?: string;
  threadSeedMessage?: string;
}

/** Output produced by the notification decision engine for a given signal. */
export interface NotificationDecision {
  shouldNotify: boolean;
  selectedChannels: NotificationChannel[];
  reasoningSummary: string;
  renderedCopy: Partial<Record<NotificationChannel, RenderedChannelCopy>>;
  deepLinkTarget?: Record<string, unknown>;
  dedupeKey: string;
  confidence: number;
  fallbackUsed: boolean;
  /** UUID of the persisted decision row (set after persistence in the decision engine). */
  persistedDecisionId?: string;
}

// -- Delivery interaction tracking --------------------------------------------

/** How the user interacted with a notification delivery. */
export type InteractionType =
  | 'viewed'
  | 'dismissed'
  | 'replied'
  | 'callback_clicked'
  | 'conversation_opened';

/** Whether the interaction was directly observed or inferred from signals. */
export type InteractionConfidence = 'explicit' | 'inferred';

/**
 * Sources that produce interaction events. Each value identifies the
 * originating subsystem or client action so callers can filter and
 * audit by provenance.
 */
export type InteractionSource =
  | 'macos_notification_view_action'
  | 'macos_notification_dismiss_action'
  | 'macos_conversation_opened'
  | 'telegram_inbound_message'
  | 'telegram_callback_query'
  | 'vellum_thread_opened'
  | (string & {});

/** Summary of interaction state materialized on notification_deliveries. */
export interface NotificationDeliverySummary {
  id: string;
  assistantId: string;
  channel: string;
  seenAt: number | null;
  seenConfidence: string | null;
  seenSource: string | null;
  seenEvidenceText: string | null;
  viewedAt: number | null;
  lastInteractionAt: number | null;
  lastInteractionType: string | null;
  lastInteractionConfidence: string | null;
  lastInteractionSource: string | null;
  lastInteractionEvidenceText: string | null;
}
