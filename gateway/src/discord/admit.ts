/**
 * Admission gate for inbound Discord messages.
 *
 * A bot invited to a community guild sees every message in every channel it
 * can view. This gate decides which of those the gateway acts on, and it is
 * the only thing standing between the assistant and a busy public server, so
 * it is deliberately conservative: a message is dropped unless it is a direct
 * mention of the bot in a channel the operator listed.
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
   * Snowflake of the parent channel when {@link channelId} is a thread.
   *
   * Discord delivers thread messages as ordinary `MESSAGE_CREATE` events keyed
   * on the thread, and the bot is auto-subscribed to every visible active
   * thread without joining. An allow-list of channels would therefore deny all
   * thread traffic, which is the same as the assistant going silent the moment
   * a conversation moves into a thread. Resolving parentage is the caller's
   * job — it holds the channel cache — and this gate accepts the result.
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
  | "not_a_guild_message"
  | "channel_not_allowed"
  | "bot_not_mentioned";

export type AdmissionVerdict =
  | { admitted: true }
  | { admitted: false; reason: AdmissionDropReason };

export interface AdmissionPolicy {
  /** The bot's own user snowflake, used for self-filtering and mention matching. */
  botUserId: string;
  /** Channel snowflakes the bot may act in. Empty admits nothing. */
  allowedChannelIds: ReadonlySet<string>;
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

  // Admission is expressed as a list of guild channels, so a DM matches no
  // entry on it. Admitting DMs is a separate policy decision, not a gap here.
  if (!candidate.guildId) {
    return drop("not_a_guild_message");
  }

  // An unset allow-list admits nothing. The operator opting the bot into a
  // guild is not the same as opting it into every channel in that guild, and
  // the failure that matters is the one where an empty list means "all".
  //
  // A thread inherits its parent's listing: listing a channel opts in the
  // conversations that branch off it, which is where a thread comes from. A
  // thread id may also be listed directly, and matches on the first check.
  const channelAllowed =
    policy.allowedChannelIds.has(candidate.channelId) ||
    (candidate.parentChannelId !== undefined &&
      policy.allowedChannelIds.has(candidate.parentChannelId));
  if (!channelAllowed) {
    return drop("channel_not_allowed");
  }

  // Requiring the bot's own id here is what keeps announcements out: Discord
  // omits `@everyone` / `@here` and role pings from the mentions array, so
  // they cannot satisfy this check.
  if (!candidate.mentionedUserIds?.includes(policy.botUserId)) {
    return drop("bot_not_mentioned");
  }

  return ADMITTED;
}
