/**
 * MESSAGE_CREATE → the canonical `GatewayInboundEvent`.
 *
 * The normalizer runs after the admission gate (`admit.ts`), so every message
 * here is either a mention of the bot in an allow-listed channel or a DM to
 * the bot. Both sit inside Discord's content exemption and carry real content.
 * It maps identity fields onto the channel-identity vocabulary:
 * `conversationExternalId` is the delivery address (the parent channel for
 * thread messages, mirroring Slack's channel + thread_ts split, and the DM
 * channel for a DM), `actorExternalId` the author's user snowflake.
 *
 * Mention markup (`<@snowflake>`) is forwarded verbatim; rendering is the
 * ingress-rendering slice's concern, and the daemon receives `raw` either way.
 */

import type { DiscordInboundEvent } from "../channels/inbound-event.js";
import type { AdmissionCandidate } from "./admit.js";
import type { DiscordMessageCreate } from "./message-schemas.js";

/**
 * Build the admission gate's input from a parsed message. `parentChannelId`
 * comes from the client's thread-parent cache — resolution is the caller's
 * job because the cache lives there (see `AdmissionCandidate.parentChannelId`).
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
  return {
    version: "v1",
    sourceChannel: "discord",
    receivedAt: new Date().toISOString(),
    message: {
      content: message.content,
      conversationExternalId: options.parentChannelId ?? message.channel_id,
      externalMessageId: message.id,
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
      ...(inThread ? { threadId: message.channel_id } : {}),
    },
    raw: options.raw,
  };
}
