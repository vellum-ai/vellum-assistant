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
  /** Snowflake of the channel the message was posted in. */
  channelId: string;
  /** Snowflake of the guild, absent for DMs. */
  guildId?: string;
  /** Snowflake of the message author. */
  authorId: string;
  /** Whether the author is itself a bot or webhook. */
  authorIsBot?: boolean;
  /** Snowflakes of users directly mentioned in the message. */
  mentionedUserIds?: readonly string[];
  /** Whether the message carried `@everyone` / `@here`. */
  mentionsEveryone?: boolean;
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
  if (candidate.authorId === policy.botUserId) return drop("self_authored");

  // Other bots and webhooks are dropped outright. Two assistants in one
  // channel that each answer the other is the same loop with more steps.
  if (candidate.authorIsBot) return drop("bot_authored");

  // Admission is expressed as a list of guild channels, so a DM matches no
  // entry on it. Admitting DMs is a separate policy decision, not a gap here.
  if (!candidate.guildId) return drop("not_a_guild_message");

  // An unset allow-list admits nothing. The operator opting the bot into a
  // guild is not the same as opting it into every channel in that guild, and
  // the failure that matters is the one where an empty list means "all".
  if (!policy.allowedChannelIds.has(candidate.channelId)) {
    return drop("channel_not_allowed");
  }

  // `@everyone` and `@here` are not mentions of this bot. Discord keeps them
  // out of the mentions array and reports them on a separate flag precisely
  // because they address the room, not a user — honouring them would opt the
  // assistant into every announcement in an allow-listed channel.
  if (!candidate.mentionedUserIds?.includes(policy.botUserId)) {
    return drop("bot_not_mentioned");
  }

  return ADMITTED;
}

/**
 * Parse an allow-list from its stored form — a comma-separated list of channel
 * snowflakes. Blank entries are dropped, so a trailing comma or an empty
 * setting yields an empty set, which admits nothing.
 */
export function parseAllowedChannelIds(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );
}
