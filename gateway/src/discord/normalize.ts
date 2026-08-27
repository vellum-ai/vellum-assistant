/**
 * MESSAGE_CREATE → the canonical `GatewayInboundEvent`.
 *
 * The normalizer runs after the admission gate (`admit.ts`), so every message
 * here is either a mention of the bot in a channel it can see, or a DM to
 * the bot. Attachment-only DMs can have empty content. It maps identity
 * fields onto the channel-identity vocabulary:
 * `conversationExternalId` is the delivery address (the parent channel for
 * thread messages, mirroring Slack's channel + thread_ts split, and the DM
 * channel for a DM), `actorExternalId` the author's user snowflake.
 *
 * Mention markup (`<@snowflake>`) is forwarded verbatim; rendering is the
 * ingress-rendering slice's concern, and the daemon receives `raw` either way.
 */

import type { DiscordInboundEvent } from "../channels/inbound-event.js";
import type { AdmissionCandidate } from "./admit.js";
import { extractDiscordAttachments } from "./attachments.js";
import type {
  DiscordMessageCreate,
  DiscordMessageDelete,
} from "./message-schemas.js";

/**
 * Build the admission gate's input from a parsed message. `parentChannelId`
 * comes from the caller's thread-parent cache; the gate reads it only under
 * a legacy allow-list, where a thread inherits its parent's listing.
 */
export function toAdmissionCandidate(
  message: DiscordMessageCreate,
  parentChannelId: string | undefined,
): AdmissionCandidate | null {
  const authorId = message.author?.id;
  if (!authorId || !message.channel_id) {
    return null;
  }
  return {
    channelId: message.channel_id,
    ...(parentChannelId !== undefined ? { parentChannelId } : {}),
    ...(message.guild_id !== undefined ? { guildId: message.guild_id } : {}),
    authorId,
    authorIsBot:
      message.author?.bot === true || message.webhook_id !== undefined,
    mentionedUserIds: (message.mentions ?? [])
      .map((mention) => mention.id)
      .filter((id) => id.length > 0),
  };
}

/**
 * Normalize an admitted message. Returns null when identity fields are
 * missing — the id schemas collapse malformed values to `""`, and an event
 * without message, conversation, or actor identity cannot be routed.
 */
export function normalizeDiscordMessage(
  message: DiscordMessageCreate,
  options: {
    /** Parent channel snowflake when the message is in a known thread. */
    parentChannelId?: string;
    /** The original dispatch `d` payload, preserved verbatim. */
    raw: Record<string, unknown>;
    /**
     * Set for a MESSAGE_UPDATE. The revision id joins the event's dedup id
     * so successive edits of one message never swallow each other, while
     * `source.messageId` keeps naming the message the edit rewrites.
     */
    edit?: { revision: string };
  },
): DiscordInboundEvent | null {
  const authorId = message.author?.id;
  if (!message.id || !message.channel_id || !authorId) {
    return null;
  }

  const inThread = options.parentChannelId !== undefined;
  // Discord marks a DM only by the absence of a guild, and a DM channel is
  // already the private one-to-one address, so it is its own conversation and
  // can never be in a thread.
  const isDirectMessage = message.guild_id === undefined;
  const attachments = extractDiscordAttachments(message.attachments);
  return {
    version: "v1",
    sourceChannel: "discord",
    receivedAt: new Date().toISOString(),
    message: {
      eventKind: options.edit ? "edit" : "message",
      content: message.content,
      conversationExternalId: options.parentChannelId ?? message.channel_id,
      externalMessageId: options.edit
        ? `${message.id}:edit:${options.edit.revision}`
        : message.id,
      ...(attachments.length > 0 && !options.edit ? { attachments } : {}),
    },
    actor: {
      actorExternalId: authorId,
      ...(message.author?.username !== undefined
        ? { username: message.author.username }
        : {}),
      ...(typeof message.author?.global_name === "string"
        ? { displayName: message.author.global_name }
        : {}),
      ...(message.author?.bot !== undefined
        ? { isBot: message.author.bot }
        : {}),
    },
    source: {
      updateId: message.id,
      messageId: message.id,
      chatType: isDirectMessage ? "dm" : "channel",
      // Discord proves a DM by the absence of a guild, and proves nothing about
      // a guild channel's visibility without fetching the channel and reading
      // its permission overwrites. Left unset rather than guessed, so a rule
      // written for public rooms cannot reach a private one. Readership is
      // proven in both directions, so `isDirectMessage` is always stated.
      isDirectMessage,
      ...(isDirectMessage ? { conversationType: "dm" as const } : {}),
      ...(inThread ? { threadId: message.channel_id } : {}),
    },
    raw: options.raw,
  };
}

/**
 * Normalize a MESSAGE_DELETE. The wire names no actor: the dispatch carries
 * only the message, channel and optional guild ids, so the actor is the
 * synthetic `discord-system` and `actorUnattributed` states the fact. The
 * daemon applies an unattributed delete only to a row it ingested, whose
 * author cleared the ACL when the message arrived; nothing here asserts who
 * deleted it.
 */
export function normalizeDiscordMessageDelete(
  del: DiscordMessageDelete,
  options: {
    parentChannelId?: string;
    raw: Record<string, unknown>;
  },
): DiscordInboundEvent | null {
  if (!del.id || !del.channel_id) {
    return null;
  }
  const inThread = options.parentChannelId !== undefined;
  const isDirectMessage = del.guild_id === undefined;
  return {
    version: "v1",
    sourceChannel: "discord",
    receivedAt: new Date().toISOString(),
    message: {
      eventKind: "delete",
      content: "",
      conversationExternalId: options.parentChannelId ?? del.channel_id,
      externalMessageId: `${del.id}:delete`,
    },
    actor: {
      actorExternalId: "discord-system",
    },
    source: {
      updateId: del.id,
      messageId: del.id,
      chatType: isDirectMessage ? "dm" : "channel",
      isDirectMessage,
      actorUnattributed: true,
      ...(isDirectMessage ? { conversationType: "dm" as const } : {}),
      ...(inThread ? { threadId: del.channel_id } : {}),
    },
    raw: options.raw,
  };
}
