/**
 * Core domain types for the unified notification system.
 *
 * Defines the channel-adapter interfaces that the broadcaster and adapters
 * depend on, plus the decision engine output contract.
 */

import type { ChannelPolicies } from "../channels/config.js";
import type { ChannelId } from "../channels/types.js";
import type { ApprovalUIMetadata } from "../runtime/channel-approval-types.js";
import type { AttentionHints } from "./signal.js";

/**
 * Derived from the channel policy registry: only channels whose
 * deliveryEnabled flag is true are valid notification channels.
 */
export type NotificationChannel = {
  [K in keyof ChannelPolicies]: ChannelPolicies[K]["notification"]["deliveryEnabled"] extends true
    ? K
    : never;
}[keyof ChannelPolicies] &
  ChannelId;

export type NotificationDeliveryStatus =
  | "pending"
  | "sent"
  | "failed"
  | "skipped";

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
  /**
   * Channel-native message identifier captured at send time (e.g. Slack `ts`).
   * Persisted onto `notification_deliveries.messageId` so later edits can
   * target the same message via `ChannelAdapter.update()`.
   */
  messageId?: string;
}

/** Resolved destination for a specific channel. */
export interface ChannelDestination {
  channel: NotificationChannel;
  endpoint?: string;
  metadata?: Record<string, unknown>;
  /** Stable binding data for channel-scoped conversation continuation. */
  bindingContext?: DestinationBindingContext;
}

/**
 * Binding data that identifies a specific external chat for a channel.
 * Used by conversation pairing to look up or create channel-scoped
 * conversations keyed by (sourceChannel, externalChatId).
 */
export interface DestinationBindingContext {
  /** The channel this binding belongs to (e.g. "telegram", "slack"). */
  sourceChannel: NotificationChannel;
  /** The channel-specific chat/conversation identifier (e.g. Telegram chat ID, phone number). */
  externalChatId: string;
  /** Optional external user identifier within the chat. */
  externalUserId?: string;
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
  /** Original signal context payload — available for channel-specific structured rendering. */
  contextPayload?: Record<string, unknown>;
  /**
   * Forwarded from the originating signal so adapters can make
   * urgency-aware decisions (e.g. the vellum adapter suppresses the OS
   * banner for non-urgent intents while still emitting the conversation
   * pairing side effects).
   */
  urgency: AttentionHints["urgency"];
  /**
   * Structured approval context for notifications that require guardian
   * action buttons (approve/reject). Built centrally by the broadcaster
   * so adapters can render channel-native approval UI without re-parsing
   * `contextPayload`.
   */
  approvalContext?: ApprovalUIMetadata;
}

/**
 * Patch supplied when an already-delivered notification is edited.
 * Adapters only need to act on `title` and `body` — feed-only fields
 * like `urgency` and `status` are handled by the home-feed patch.
 */
export interface ChannelUpdatePayload {
  title?: string;
  body?: string;
}

/** Interface that each channel adapter must implement. */
export interface ChannelAdapter {
  channel: NotificationChannel;
  send(
    payload: ChannelDeliveryPayload,
    destination: ChannelDestination,
  ): Promise<DeliveryResult>;
  /**
   * Optional: edit a previously-sent message in place. Channels that
   * cannot edit (push, email, SMS) omit this and the router treats
   * them as `"unsupported"`. Adapters that implement it use
   * `delivery.messageId` (captured at send time) as the channel-native
   * handle for the in-place update.
   */
  update?(
    delivery: ChannelUpdateContext,
    patch: ChannelUpdatePayload,
  ): Promise<DeliveryResult>;
}

/** Per-delivery state an adapter needs to update a previously-sent message. */
export interface ChannelUpdateContext {
  /** notification_deliveries.id */
  deliveryId: string;
  /** Channel-native destination (e.g. Slack chat id). */
  destination: string;
  /** Channel-native message identifier captured at send time. */
  messageId: string | null;
}

// -- Decision engine output ---------------------------------------------------

/** Rendered notification copy for a single channel. */
export interface RenderedChannelCopy {
  title: string;
  body: string;
  /** Channel-native delivery text (e.g. Telegram chat message body). */
  deliveryText?: string;
  conversationTitle?: string;
  conversationSeedMessage?: string;
  /**
   * Structured content blocks for the seed message. When present,
   * conversation pairing stores `JSON.stringify(seedContentBlocks)` as the
   * message content instead of the plain-text seed, enabling Surface
   * rendering in the web/macOS/iOS apps.
   *
   * Typically includes a `ui_surface` block (rendered as an interactive
   * card) followed by a `text` block (plain-text fallback for search,
   * backward-compatible clients, and CLI display).
   */
  seedContentBlocks?: unknown[];
}

// -- Conversation action types ------------------------------------------------

/** Start a new conversation for the notification delivery. */
export interface ConversationActionStartNew {
  action: "start_new";
}

/** Reuse an existing conversation identified by conversationId. */
export interface ConversationActionReuseExisting {
  action: "reuse_existing";
  conversationId: string;
}

/** Per-channel conversation action — either start a new conversation or reuse an existing one. */
export type ConversationAction =
  | ConversationActionStartNew
  | ConversationActionReuseExisting;

/** Output produced by the notification decision engine for a given signal. */
export interface NotificationDecision {
  shouldNotify: boolean;
  selectedChannels: NotificationChannel[];
  reasoningSummary: string;
  renderedCopy: Partial<Record<NotificationChannel, RenderedChannelCopy>>;
  /** Per-channel conversation actions decided by the model. Absent channels default to start_new. */
  conversationActions?: Partial<
    Record<NotificationChannel, ConversationAction>
  >;
  deepLinkTarget?: Record<string, unknown>;
  dedupeKey: string;
  confidence: number;
  fallbackUsed: boolean;
  /** UUID of the persisted decision row (set after persistence in the decision engine). */
  persistedDecisionId?: string;
}
