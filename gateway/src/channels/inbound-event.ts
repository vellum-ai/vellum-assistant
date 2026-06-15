import type { ChannelId } from "./types.js";

/**
 * Channel-discriminated inbound event model.
 *
 * Every normalized inbound event carries explicit `conversationExternalId`
 * (delivery/conversation address) and `actorExternalId` (sender identity) fields.
 * The discriminated union is keyed by `sourceChannel`.
 */

export type InboundChannelId = Extract<
  ChannelId,
  "telegram" | "whatsapp" | "slack" | "email" | "a2a"
>;

interface InboundEventBase<C extends InboundChannelId> {
  version: "v1";
  sourceChannel: C;
  receivedAt: string;
  message: {
    content: string;
    conversationExternalId: string;
    externalMessageId: string;
    isEdit?: boolean;
    callbackQueryId?: string;
    callbackData?: string;
    attachments?: Array<{
      type: "photo" | "document" | "image" | "video" | "audio" | "sticker";
      fileId: string;
      fileName?: string;
      mimeType?: string;
      fileSize?: number;
    }>;
  };
  actor: {
    actorExternalId: string;
    username?: string;
    displayName?: string;
    firstName?: string;
    lastName?: string;
    languageCode?: string;
    isBot?: boolean;
    timezone?: string;
    timezoneLabel?: string;
    timezoneOffsetSeconds?: number;
    /** Slack-specific: user is from an external workspace (Slack Connect). */
    isStranger?: boolean;
    /** Slack-specific: user is a guest / restricted account. */
    isRestricted?: boolean;
  };
  source: {
    updateId: string;
    messageId?: string;
    chatType?: string;
    /**
     * Thread/conversation-group identifier, when the source channel carries one
     * (e.g. Slack `thread_ts`). Channel-agnostic name so other channels (email
     * `In-Reply-To`, etc.) can reuse the field later.
     */
    threadId?: string;
    channelName?: string;
  };
  raw: Record<string, unknown>;
}

export type TelegramInboundEvent = InboundEventBase<"telegram">;
export type WhatsAppInboundEvent = InboundEventBase<"whatsapp">;
export type SlackInboundEvent = InboundEventBase<"slack">;
export type EmailInboundEvent = InboundEventBase<"email">;
export type A2aInboundEvent = InboundEventBase<"a2a">;

export type GatewayInboundEvent =
  | TelegramInboundEvent
  | WhatsAppInboundEvent
  | SlackInboundEvent
  | EmailInboundEvent
  | A2aInboundEvent;
