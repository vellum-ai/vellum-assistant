/**
 * Core domain types for the unified notification system.
 *
 * The old rigid NotificationType enum and delivery-class map have been removed
 * in favor of the signal-based model (see signal.ts). What remains here are
 * the channel-adapter interfaces that the broadcaster and adapters depend on.
 */

export type NotificationChannel = 'macos' | 'telegram';

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

// -- Channel adapter interfaces -----------------------------------------------

/** Copy rendered by the copy-composer for a single notification delivery. */
export interface PreparedDelivery {
  sourceEventName: string;
  title: string;
  body: string;
  threadTitle?: string;
  threadSeedMessage?: string;
  deepLinkMetadata?: Record<string, unknown>;
}

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

/** Interface that each channel adapter must implement. */
export interface ChannelAdapter {
  channel: NotificationChannel;
  send(delivery: PreparedDelivery, destination: ChannelDestination): Promise<DeliveryResult>;
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
}
