/**
 * Admission gate for inbound Discord messages.
 *
 * A bot invited to a community guild sees every message in every channel it
 * can view. This gate decides which of those the gateway acts on, and it is
 * the only thing standing between the assistant and a busy public server, so
 * it is deliberately conservative: a message is dropped unless it is a direct
 * mention of the bot.
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
 * A DM is the one message that is already addressed to the bot and nobody
 * else, so it is admitted on a separate lane, without a mention: @-ing a bot
 * in its own DM is not how anyone writes. What that lane admits is a *room*, not a
 * person. Who may actually be answered there is the trust-class admission
 * floor's decision downstream, and Discord's floor admits trusted contacts.
 *
 * This is admission of *rooms and intent* — distinct from, and evaluated
 * before, the trust-class admission floor that governs *actors* once an event
 * reaches the runtime.
 *
 * The input is a structural shape rather than a parsed-payload type so the
 * gate stays a pure function over the few fields it reads.
 */

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

export type AdmissionDropReason =
  | "self_authored"
  | "bot_authored"
  | "channel_not_allowed"
  | "bot_not_mentioned";

export type AdmissionVerdict =
  | { admitted: true }
  | { admitted: false; reason: AdmissionDropReason };

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

const ADMITTED: AdmissionVerdict = { admitted: true };

function drop(reason: AdmissionDropReason): AdmissionVerdict {
  return { admitted: false, reason };
}

/**
 * Decide whether a message is one the gateway acts on.
 *
 * Checks run cheapest-and-most-decisive first, and every one of them is a
 * denial — there is no branch that admits a message the operator did not ask
 * for.
 */
export function admitDiscordMessage(
  candidate: AdmissionCandidate,
  policy: AdmissionPolicy,
): AdmissionVerdict {
  // The bot's own messages come back over the same socket. Processing them is
  // how a reply loop starts.
  if (candidate.authorId === policy.botUserId) {
    return drop("self_authored");
  }

  // Other bots and webhooks are dropped outright. Two assistants in one
  // channel that each answer the other is the same loop with more steps.
  if (candidate.authorIsBot) {
    return drop("bot_authored");
  }

  // A DM is already addressed to the bot alone, so the guild mention check
  // below has nothing to say about it: it needs no mention to be meant for
  // the bot. The room is admitted; whether this particular person is
  // answered in it is the runtime's trust-class floor to decide.
  //
  // This reads an absent guild as a DM, which makes the absence load-bearing:
  // it is the only thing standing between "private" and "a public channel
  // admitted without either control". The ingress schema therefore collapses a
  // malformed `guild_id` to a sentinel rather than to `undefined`, so a parse
  // failure stays on the guild path. Do not relax that without moving this
  // branch onto positive evidence of a DM.
  //
  // A Discord *group* DM is also guild-less and would be admitted here. This
  // app cannot be in one: a bot joins a group DM only via the `gdm.join`
  // OAuth scope, which no install path grants. The fallback invite link
  // requests the `bot` scope alone, and an app whose own install settings
  // carry `gdm.join` is warned to remove it at setup, naming this branch as
  // the reason. Carrying that scope would need this branch to distinguish
  // the two first.
  if (!candidate.guildId) {
    return ADMITTED;
  }

  // The legacy fence: a persisted allow-list keeps gating rooms until the
  // operator clears it. A thread inherits its parent's listing, matching the
  // model the list was configured under.
  if (policy.legacyAllowedChannelIds !== undefined) {
    const channelAllowed =
      policy.legacyAllowedChannelIds.has(candidate.channelId) ||
      (candidate.parentChannelId !== undefined &&
        policy.legacyAllowedChannelIds.has(candidate.parentChannelId));
    if (!channelAllowed) {
      return drop("channel_not_allowed");
    }
  }

  // Requiring the bot's own id here is what keeps announcements out: Discord
  // omits `@everyone` / `@here` and role pings from the mentions array, so
  // they cannot satisfy this check.
  if (!candidate.mentionedUserIds?.includes(policy.botUserId)) {
    return drop("bot_not_mentioned");
  }

  return ADMITTED;
}
