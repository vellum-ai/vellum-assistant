/**
 * Admission gate for inbound Telegram messages: the Telegram side of the
 * shared verdict in `channels/room-admission.ts`.
 *
 * A bot in a group sees whatever Telegram delivers it. With privacy mode on,
 * the default, that is already only mentions, replies to the bot, and
 * commands. With privacy mode off, or for a bot promoted to administrator
 * (Telegram documents that admins receive everything), it is every message
 * in the room. The verdict makes the two cases behave the same.
 *
 * A Telegram "channel" is a broadcast feed, not a room, and nothing in the
 * product addresses one. It is refused rather than mapped, for the reason
 * `telegramConversationType` gives.
 *
 * Telegram never delivers a bot's own posts back to it, nor other bots'
 * messages, so the self and bot checks never fire on a real update; they cost
 * nothing and a reply loop is the failure they prevent.
 *
 * The input is a structural shape rather than a parsed-payload type so the
 * gate stays a pure function over the few facts it reads.
 */

import {
  admitRoomMessage,
  type RoomAdmissionVerdict,
} from "../channels/room-admission.js";
import type { TelegramMessage, TelegramMessageEntity } from "./schemas.js";

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

export interface TelegramAdmissionPolicy {
  /** The bot's own user id, for self-filtering, text mentions, and replies. */
  botUserId?: string;
  /** The bot's `@username` without the `@`, for `mention` entities. */
  botUsername?: string;
}

/**
 * Decide whether a message is one the gateway acts on: Telegram's facts,
 * mapped onto the neutral candidate the shared verdict reads.
 */
export function admitTelegramMessage(
  candidate: TelegramAdmissionCandidate,
  policy: TelegramAdmissionPolicy,
): RoomAdmissionVerdict {
  const identityKnown =
    policy.botUserId !== undefined || policy.botUsername !== undefined;
  return admitRoomMessage({
    authorIsSelf:
      policy.botUserId !== undefined && candidate.authorId === policy.botUserId,
    authorIsBot: candidate.authorIsBot === true,
    isDirectChat: candidate.chatType === "private",
    chatSupported:
      candidate.chatType === "group" || candidate.chatType === "supergroup",
    roomAllowed: true,
    addressesBot: identityKnown ? isBotAddressed(candidate, policy) : undefined,
  });
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

/** Who a message names, read off its entities the way the verdict wants them. */
export function toAdmissionCandidate(
  message: TelegramMessage,
): TelegramAdmissionCandidate {
  const mentionedUsernames: string[] = [];
  const mentionedUserIds: string[] = [];
  const read = (
    text: string | undefined,
    entities: TelegramMessageEntity[],
  ) => {
    for (const entity of entities) {
      if (entity.type === "text_mention" && entity.user?.id != null) {
        mentionedUserIds.push(String(entity.user.id));
        continue;
      }
      if (
        (entity.type !== "mention" && entity.type !== "bot_command") ||
        text === undefined ||
        entity.offset == null ||
        entity.length == null
      ) {
        continue;
      }
      // Offsets and lengths are in UTF-16 code units, which is what a
      // JavaScript string indexes by.
      const span = text.slice(entity.offset, entity.offset + entity.length);
      const at = span.indexOf("@");
      if (at === -1) {
        continue;
      }
      const username = span
        .slice(at + 1)
        .trim()
        .toLowerCase();
      if (username) {
        mentionedUsernames.push(username);
      }
    }
  };
  read(message.text, message.entities ?? []);
  read(message.caption, message.caption_entities ?? []);
  return {
    chatType: message.chat?.type,
    authorId: message.from?.id != null ? String(message.from.id) : undefined,
    authorIsBot: message.from?.is_bot,
    mentionedUsernames,
    mentionedUserIds,
    repliedToAuthorId:
      message.reply_to_message?.from?.id != null
        ? String(message.reply_to_message.from.id)
        : undefined,
  };
}
