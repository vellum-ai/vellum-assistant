/**
 * Admission gate for inbound Discord messages: the Discord side of the
 * shared verdict in `channels/room-admission.ts`.
 *
 * Which rooms the bot can see at all is Discord's decision, not ours. A bot
 * without `VIEW_CHANNEL` on a channel cannot read its messages, so the server
 * owner scopes the bot with channel and role permissions the same way they
 * would anywhere else, in the UI they already know.
 *
 * One legacy exception preserves persisted operator intent: an install whose
 * config still carries a non-empty `discord.allowedChannelIds` restricted the
 * bot on purpose under the old model, and an upgrade must not widen that
 * scope before they act. While the list is present it keeps gating guild
 * rooms (threads inherit their parent's listing); clearing the config entry
 * is the operator's explicit adoption of the permission model. Nothing
 * writes the list anymore, so no new install ever has one.
 *
 * This is admission of *rooms and intent*, distinct from and evaluated before
 * the trust-class admission floor that governs *actors* once an event reaches
 * the runtime.
 *
 * The input is a structural shape rather than a parsed-payload type so the
 * gate stays a pure function over the few fields it reads.
 */

import {
  admitRoomMessage,
  type RoomAdmissionVerdict,
} from "../channels/room-admission.js";

/** The fields of a Discord message this gate reads. */
export interface AdmissionCandidate {
  /**
   * Snowflake of the channel the message was posted in. For a message in a
   * thread this is the *thread's* id, not the channel the thread hangs off.
   */
  channelId: string;
  /**
   * Snowflake of the parent channel when {@link channelId} is a thread,
   * resolved by the caller's thread-parent cache. Read only under a legacy
   * allow-list, where a thread inherits its parent's listing.
   */
  parentChannelId?: string;
  /** Snowflake of the guild, absent for DMs. */
  guildId?: string;
  /** Snowflake of the message author. */
  authorId: string;
  /** Whether the author is itself a bot or webhook. */
  authorIsBot?: boolean;
  /**
   * Snowflakes of users directly mentioned in the message.
   *
   * Discord omits `@everyone` / `@here` and role pings from this array — they
   * are reported on separate fields — so a message that addresses the room
   * never looks like a message that addresses the bot.
   */
  mentionedUserIds?: readonly string[];
}

export interface AdmissionPolicy {
  /** The bot's own user snowflake, used for self-filtering and mention matching. */
  botUserId: string;
  /**
   * A legacy install's persisted room restriction, present only while its
   * config still carries a non-empty `discord.allowedChannelIds`. Enforced
   * so an upgrade cannot widen the operator's scope before they clear it;
   * absent on every install that never wrote one.
   */
  legacyAllowedChannelIds?: ReadonlySet<string>;
}

/**
 * Decide whether a message is one the gateway acts on: Discord's facts,
 * mapped onto the neutral candidate the shared verdict reads.
 *
 * Discord marks a DM only by the absence of a guild. That makes the absence
 * load-bearing: it is the only thing standing between "private" and "a public
 * channel admitted without either control", so the ingress schema collapses a
 * malformed `guild_id` to a sentinel rather than to `undefined`, and a parse
 * failure stays on the guild path. Do not relax that without moving this onto
 * positive evidence of a DM.
 *
 * A Discord *group* DM is also guild-less and would be admitted here. This
 * app cannot be in one: a bot joins a group DM only via the `gdm.join` OAuth
 * scope, which no install path grants. The fallback invite link requests the
 * `bot` scope alone, and an app whose own install settings carry `gdm.join`
 * is warned to remove it at setup, naming this as the reason.
 *
 * Requiring the bot's own id in the mentions array is what keeps announcements
 * out: Discord omits `@everyone` / `@here` and role pings from that array, so
 * they cannot satisfy the check.
 */
export function admitDiscordMessage(
  candidate: AdmissionCandidate,
  policy: AdmissionPolicy,
): RoomAdmissionVerdict {
  const isDirectChat = candidate.guildId === undefined;
  // A thread inherits its parent's listing, matching the model the legacy
  // allow-list was configured under.
  const roomAllowed =
    policy.legacyAllowedChannelIds === undefined ||
    policy.legacyAllowedChannelIds.has(candidate.channelId) ||
    (candidate.parentChannelId !== undefined &&
      policy.legacyAllowedChannelIds.has(candidate.parentChannelId));
  return admitRoomMessage({
    authorIsSelf: candidate.authorId === policy.botUserId,
    authorIsBot: candidate.authorIsBot === true,
    isDirectChat,
    // Discord delivers only DMs and guild channels the bot can view; there
    // is no third kind to refuse.
    chatSupported: true,
    roomAllowed,
    addressesBot:
      candidate.mentionedUserIds?.includes(policy.botUserId) === true,
  });
}
