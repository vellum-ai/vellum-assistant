/**
 * Admission gate for inbound Telegram messages.
 *
 * A bot in a group sees whatever Telegram delivers it. With privacy mode on,
 * the default, that is already only mentions, replies to the bot, and
 * commands. With privacy mode off, or for a bot promoted to administrator
 * (Telegram documents that admins receive everything), it is every message
 * in the room. This gate makes the two cases behave the same: a room message
 * is acted on only when it addresses the bot, and everything else is dropped
 * before it can start a turn. It is the Telegram shape of the Discord gate in
 * `discord/admit.ts`, and the rules are deliberately the same.
 *
 * A private chat is the one message already addressed to the bot and nobody
 * else, so it is admitted on its own lane without a mention. What that lane
 * admits is a chat, not a person: who may be answered is the trust-class
 * admission floor's decision downstream.
 *
 * A Telegram "channel" is a broadcast feed, not a room, and nothing in the
 * product addresses one. It is refused here rather than mapped, for the
 * reason `telegramConversationType` gives.
 *
 * The input is a structural shape rather than a parsed-payload type so the
 * gate stays a pure function over the few facts it reads.
 */

/** The facts of a Telegram message this gate reads. */
export interface TelegramAdmissionCandidate {
  /** Telegram's `chat.type`: private, group, supergroup, or channel. */
  chatType: string | undefined;
  /** `from.id` of the sender. */
  authorId: string | undefined;
  /** `from.is_bot` of the sender. */
  authorIsBot: boolean | undefined;
  /**
   * Usernames the text names, lowercased and without the `@`: every
   * `mention` entity, plus the `@bot` suffix of a `bot_command` such as
   * `/start@jobs_bot`.
   */
  mentionedUsernames: readonly string[];
  /** User ids named by `text_mention` entities (accounts with no username). */
  mentionedUserIds: readonly string[];
  /** `reply_to_message.from.id`, when this message replies to one. */
  repliedToAuthorId: string | undefined;
}

export type TelegramAdmissionDropReason =
  | "self_authored"
  | "bot_authored"
  | "chat_not_supported"
  | "bot_identity_unknown"
  | "bot_not_mentioned";

export type TelegramAdmissionVerdict =
  | {
      admitted: true;
      /**
       * Whether the message addresses the bot by name or by reply. Proven in
       * both directions whenever the bot's identity is known, so it is always
       * stated on an admitted message.
       */
      botMentioned: boolean;
    }
  | { admitted: false; reason: TelegramAdmissionDropReason };

export interface TelegramAdmissionPolicy {
  /** The bot's own user id, for self-filtering, text mentions, and replies. */
  botUserId?: string;
  /** The bot's `@username` without the `@`, for `mention` entities. */
  botUsername?: string;
}

function drop(reason: TelegramAdmissionDropReason): TelegramAdmissionVerdict {
  return { admitted: false, reason };
}

/**
 * Decide whether a message is one the gateway acts on.
 *
 * Checks run cheapest-and-most-decisive first, and every one of them is a
 * denial: there is no branch that admits a message the operator did not ask
 * for.
 */
export function admitTelegramMessage(
  candidate: TelegramAdmissionCandidate,
  policy: TelegramAdmissionPolicy,
): TelegramAdmissionVerdict {
  // Telegram does not deliver a bot's own posts back to it, nor other bots'
  // messages, so these two never fire on a real update. They stay because a
  // reply loop is the failure they prevent and they cost nothing.
  if (
    policy.botUserId !== undefined &&
    candidate.authorId === policy.botUserId
  ) {
    return drop("self_authored");
  }
  if (candidate.authorIsBot) {
    return drop("bot_authored");
  }

  const mentioned = isBotAddressed(candidate, policy);

  // A private chat is already addressed to the bot alone. The chat is
  // admitted; whether this person is answered is the runtime's floor to
  // decide.
  if (candidate.chatType === "private") {
    return { admitted: true, botMentioned: mentioned };
  }

  if (candidate.chatType !== "group" && candidate.chatType !== "supergroup") {
    return drop("chat_not_supported");
  }

  // Without its own identity the gate cannot tell an addressed room message
  // from any other, and admitting every message is the one thing it must
  // never do.
  if (policy.botUserId === undefined && policy.botUsername === undefined) {
    return drop("bot_identity_unknown");
  }

  if (!mentioned) {
    return drop("bot_not_mentioned");
  }

  return { admitted: true, botMentioned: true };
}

function isBotAddressed(
  candidate: TelegramAdmissionCandidate,
  policy: TelegramAdmissionPolicy,
): boolean {
  if (
    policy.botUsername !== undefined &&
    candidate.mentionedUsernames.includes(policy.botUsername.toLowerCase())
  ) {
    return true;
  }
  if (policy.botUserId === undefined) {
    return false;
  }
  return (
    candidate.mentionedUserIds.includes(policy.botUserId) ||
    candidate.repliedToAuthorId === policy.botUserId
  );
}
