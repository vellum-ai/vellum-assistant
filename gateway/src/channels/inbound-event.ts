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
    /**
     * Whether this message was explicitly addressed to the bot — e.g. a Slack
     * message containing `<@bot>`, a DM in any 1:1 channel, or an email with
     * the bot in `To:`. Distinct from "the channel exists" or "the bot is
     * subscribed to it." When `false`, the message reached the runtime via a
     * tracked-thread / opt-in path and the model should apply response
     * discretion. When `undefined`, the channel did not derive the signal —
     * the daemon defaults to `true` (today's behavior).
     */
    directlyAddressed?: boolean;
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
    /**
     * Thread/conversation-group identifier, when the source channel carries one
     * (e.g. Slack `thread_ts`). Channel-agnostic name so other channels (email
     * `In-Reply-To`, etc.) can reuse the field later.
     */
    threadId?: string;
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
