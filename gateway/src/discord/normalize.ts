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
  DiscordInteraction,
  DiscordMessageCreate,
  DiscordMessageDelete,
  DiscordMessageReaction,
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
/**
 * Normalize a component-button INTERACTION_CREATE into the button event
 * family, the same shape a Telegram callback query takes: `callbackData`
 * carries the component's `custom_id` (`apr:<requestId>:<action>` on an
 * approval card) and `source.messageId` names the card the press landed on.
 * The actor is `user` in a DM and `member.user` in a guild; an interaction
 * whose actor cannot be named, or whose actor is a bot, cannot be routed
 * and drops.
 */
export function normalizeDiscordInteraction(
  interaction: DiscordInteraction,
  options: {
    parentChannelId?: string;
    raw: Record<string, unknown>;
  },
): DiscordInboundEvent | null {
  const actor = interaction.user ?? interaction.member?.user;
  const customId = interaction.data?.custom_id;
  if (
    !interaction.id ||
    !interaction.channel_id ||
    !customId ||
    !actor?.id ||
    actor.bot === true
  ) {
    return null;
  }
  const inThread = options.parentChannelId !== undefined;
  const isDirectMessage = interaction.guild_id === undefined;
  return {
    version: "v1",
    sourceChannel: "discord",
    receivedAt: new Date().toISOString(),
    message: {
      eventKind: "button",
      content: customId,
      conversationExternalId: options.parentChannelId ?? interaction.channel_id,
      externalMessageId: interaction.id,
      callbackData: customId,
    },
    actor: {
      actorExternalId: actor.id,
      ...(actor.username !== undefined ? { username: actor.username } : {}),
      ...(typeof actor.global_name === "string"
        ? { displayName: actor.global_name }
        : {}),
      ...(actor.bot !== undefined ? { isBot: actor.bot } : {}),
    },
    source: {
      updateId: interaction.id,
      messageId: interaction.message?.id,
      chatType: isDirectMessage ? "dm" : "channel",
      isDirectMessage,
      ...(isDirectMessage ? { conversationType: "dm" as const } : {}),
      ...(inThread ? { threadId: interaction.channel_id } : {}),
    },
    raw: options.raw,
  };
}

export function normalizeDiscordMessageReaction(
  reaction: DiscordMessageReaction,
  options: {
    op: "added" | "removed";
    parentChannelId?: string;
    raw: Record<string, unknown>;
  },
): DiscordInboundEvent | null {
  // The emoji rides in Discord's own vocabulary: a unicode emoji's name IS
  // the character, and a custom emoji is forwarded in its canonical
  // `<:name:id>` mention form. The mention form is load-bearing for the
  // guardian rail: a guild custom emoji's name is arbitrary text in the
  // same string space as Slack's colon names, so a bare name like
  // `white_check_mark` would read as approval vocabulary; the angle-bracket
  // form can never collide with it, keeping custom emoji non-actionable
  // transcript annotations with an unambiguous identity. An entry with no
  // name (a deleted custom emoji on REMOVE) cannot be expressed and drops.
  if (!reaction.message_id || !reaction.channel_id || !reaction.user_id) {
    return null;
  }
  const emojiName = reaction.emoji?.name;
  if (emojiName == null || emojiName.length === 0) {
    return null;
  }
  const customEmojiId = reaction.emoji?.id;
  const emoji =
    customEmojiId != null ? `<:${emojiName}:${customEmojiId}>` : emojiName;
  const inThread = options.parentChannelId !== undefined;
  const isDirectMessage = reaction.guild_id === undefined;
  // The reactor joins the dedup id so two users reacting with the same emoji
  // on one message stay distinct events, and the op suffix keeps an add and
  // its removal distinct. A re-add after a removal repeats the add's id and
  // dedups away downstream, matching the Slack reaction id shape.
  const externalMessageId =
    options.op === "added"
      ? `${reaction.message_id}:reaction:${emoji}:${reaction.user_id}`
      : `${reaction.message_id}:reaction:${emoji}:${reaction.user_id}:removed`;
  return {
    version: "v1",
    sourceChannel: "discord",
    receivedAt: new Date().toISOString(),
    message: {
      eventKind: "reaction",
      // A reaction has no user-authored text; its payload is structured.
      content: "",
      conversationExternalId: options.parentChannelId ?? reaction.channel_id,
      externalMessageId,
      reaction: {
        op: options.op,
        emoji,
        targetMessageId: reaction.message_id,
      },
    },
    actor: {
      actorExternalId: reaction.user_id,
    },
    source: {
      updateId: reaction.message_id,
      messageId: reaction.message_id,
      chatType: isDirectMessage ? "dm" : "channel",
      isDirectMessage,
      ...(isDirectMessage ? { conversationType: "dm" as const } : {}),
      ...(inThread ? { threadId: reaction.channel_id } : {}),
    },
    raw: options.raw,
  };
}

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
