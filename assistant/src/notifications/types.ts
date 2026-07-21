/**
 * Core domain types for the unified notification system.
 *
 * Data shapes are defined as Zod schemas — types derived via `z.infer`
 * so runtime validation and compile-time types stay in sync.
 *
 * Behavioral interfaces (ChannelAdapter) remain as TypeScript interfaces.
 */

import { ApprovalUIMetadataSchema } from "@vellumai/gateway-client";
import { z } from "zod";

import type { ChannelPolicies } from "../channels/config.js";
import type { ChannelId } from "../channels/types.js";
import { AccessRequestPayloadSchema } from "./access-request-copy.js";
import { UrgencySchema } from "./urgency.js";

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

export const NotificationDeliveryStatusSchema = z.enum([
  "pending",
  "sent",
  "failed",
  "skipped",
]);
export type NotificationDeliveryStatus = z.infer<
  typeof NotificationDeliveryStatusSchema
>;

export const NotificationDeliveryResultSchema = z.object({
  channel: z.string(),
  destination: z.string(),
  status: NotificationDeliveryStatusSchema,
  errorCode: z.string().optional(),
  errorMessage: z.string().optional(),
  sentAt: z.number().optional(),
  conversationId: z.string().optional(),
  messageId: z.string().optional(),
  conversationStrategy: z.string().optional(),
});
export type NotificationDeliveryResult = z.infer<
  typeof NotificationDeliveryResultSchema
>;

// -- Channel adapter data shapes ----------------------------------------------

export const DeliveryResultSchema = z.object({
  success: z.boolean(),
  error: z.string().optional(),
  messageId: z.string().optional(),
});
export type DeliveryResult = z.infer<typeof DeliveryResultSchema>;

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
  sourceChannel: NotificationChannel;
  externalChatId: string;
  externalUserId?: string;
}

// -- Rendered copy & delivery payload -----------------------------------------

export const RenderedChannelCopySchema = z.object({
  title: z.string(),
  body: z.string(),
  deliveryText: z.string().optional(),
  conversationTitle: z.string().optional(),
  conversationSeedMessage: z.string().optional(),
  seedContentBlocks: z.array(z.unknown()).optional(),
});
export type RenderedChannelCopy = z.infer<typeof RenderedChannelCopySchema>;

export const ChannelDeliveryPayloadSchema = z.object({
  deliveryId: z.string().optional(),
  sourceEventName: z.string(),
  copy: RenderedChannelCopySchema,
  deepLinkTarget: z.record(z.string(), z.unknown()).optional(),
  contextPayload: z.record(z.string(), z.unknown()).optional(),
  urgency: UrgencySchema,
  approvalContext: ApprovalUIMetadataSchema.optional(),
  accessRequestContext: AccessRequestPayloadSchema.optional(),
});
export type ChannelDeliveryPayload = z.infer<
  typeof ChannelDeliveryPayloadSchema
>;

export interface ChannelUpdatePayload {
  title?: string;
  body?: string;
}

// -- Channel adapter interface ------------------------------------------------

/** Interface that each channel adapter must implement. */
export interface ChannelAdapter {
  channel: NotificationChannel;
  send(
    payload: ChannelDeliveryPayload,
    destination: ChannelDestination,
  ): Promise<DeliveryResult>;
  update?(
    delivery: ChannelUpdateContext,
    patch: ChannelUpdatePayload,
  ): Promise<DeliveryResult>;
}

export interface ChannelUpdateContext {
  deliveryId: string;
  destination: string;
  messageId: string | null;
}

// -- Conversation action types ------------------------------------------------

export const ConversationActionSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("start_new") }),
  z.object({
    action: z.literal("reuse_existing"),
    conversationId: z.string(),
  }),
]);
export type ConversationAction = z.infer<typeof ConversationActionSchema>;

// -- Decision engine output ---------------------------------------------------

export const NotificationDecisionSchema = z.object({
  shouldNotify: z.boolean(),
  selectedChannels: z.array(z.string()),
  reasoningSummary: z.string(),
  renderedCopy: z.record(z.string(), RenderedChannelCopySchema),
  conversationActions: z
    .record(z.string(), ConversationActionSchema)
    .optional(),
  deepLinkTarget: z.record(z.string(), z.unknown()).optional(),
  dedupeKey: z.string(),
  confidence: z.number(),
  fallbackUsed: z.boolean(),
  persistedDecisionId: z.string().optional(),
});

/**
 * Decision engine output. `selectedChannels` and `renderedCopy` are keyed
 * by `NotificationChannel` — narrower than the Zod schema's `string` since
 * `NotificationChannel` is a computed type derived from the channel config
 * registry and cannot be expressed as a Zod enum.
 */
export interface NotificationDecision {
  shouldNotify: boolean;
  selectedChannels: NotificationChannel[];
  reasoningSummary: string;
  renderedCopy: Partial<Record<NotificationChannel, RenderedChannelCopy>>;
  conversationActions?: Partial<
    Record<NotificationChannel, ConversationAction>
  >;
  deepLinkTarget?: Record<string, unknown>;
  dedupeKey: string;
  confidence: number;
  fallbackUsed: boolean;
  persistedDecisionId?: string;
}
