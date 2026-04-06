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
  "telegram" | "whatsapp" | "slack" | "email"
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
  };
  source: {
    updateId: string;
    messageId?: string;
    chatType?: string;
  };
  raw: Record<string, unknown>;
}

export type TelegramInboundEvent = InboundEventBase<"telegram">;
export type WhatsAppInboundEvent = InboundEventBase<"whatsapp">;
export type SlackInboundEvent = InboundEventBase<"slack">;
export type EmailInboundEvent = InboundEventBase<"email">;

export type GatewayInboundEvent =
  | TelegramInboundEvent
  | WhatsAppInboundEvent
  | SlackInboundEvent
  | EmailInboundEvent;
