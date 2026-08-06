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
  "telegram" | "whatsapp" | "slack" | "email" | "a2a" | "discord"
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
    /** Slack-specific: team ID the actor belongs to. */
    teamId?: string;
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
    /**
     * Slack-specific: what the sender had open when they messaged the app,
     * ordered by relevance. `value` is an id string for channel / canvas /
     * list entities, and an object for `slack#/types/message_context`, which
     * points at a specific message or thread.
     */
    appContext?: {
      entities: Array<{
        type: string;
        value: string | { messageTs?: string; channelId?: string };
        teamId?: string;
        enterpriseId?: string;
      }>;
    };
  };
  raw: Record<string, unknown>;
}

export type TelegramInboundEvent = InboundEventBase<"telegram">;
export type WhatsAppInboundEvent = InboundEventBase<"whatsapp">;
export type SlackInboundEvent = InboundEventBase<"slack">;
export type EmailInboundEvent = InboundEventBase<"email">;
export type A2aInboundEvent = InboundEventBase<"a2a">;
/**
 * Constructed by `discord/normalize.ts`. `conversationExternalId` is the
 * channel snowflake — the parent channel when the message is in a thread —
 * `actorExternalId` the author's user snowflake, and `source.threadId` the
 * thread or forum-post snowflake for thread messages.
 */
export type DiscordInboundEvent = InboundEventBase<"discord">;

export type GatewayInboundEvent =
  | TelegramInboundEvent
  | WhatsAppInboundEvent
  | SlackInboundEvent
  | EmailInboundEvent
  | A2aInboundEvent
  | DiscordInboundEvent;
