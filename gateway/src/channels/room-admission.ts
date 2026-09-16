/**
 * The one decision every room-capable channel makes about an inbound
 * message: is this something the gateway acts on?
 *
 * A bot in a room sees whatever its platform delivers, which on a busy server
 * or a group with privacy mode off is every message. This verdict is what
 * stands between that firehose and a turn, so it is deliberately
 * conservative: a room message is acted on only when it addresses the bot,
 * and every check is a denial. There is no branch that admits a message the
 * operator did not ask for.
 *
 * A direct chat is the one message already addressed to the bot and nobody
 * else, so it is admitted on its own lane without a mention. What that lane
 * admits is a chat, not a person: who may be answered there is the
 * trust-class admission floor's decision downstream.
 *
 * The candidate is neutral on purpose. How a platform proves "direct" (Discord
 * by the absence of a guild, Telegram by `chat.type`) and "addressed" (a
 * mentions array, text entities, a reply to the bot's post) is the adapter's
 * side of the seam, built in `discord/admit.ts` and `telegram/admit.ts`. This
 * module never reads a platform field.
 */

import type { AdmissionDropLogLevel } from "./admission-drop-log.js";

/** What a channel has proven about one inbound message. */
export interface RoomAdmissionCandidate {
  /** The sender is the bot itself. */
  authorIsSelf: boolean;
  /** The sender is another bot, integration, or webhook. */
  authorIsBot: boolean;
  /** The chat has exactly one human reader besides the bot. */
  isDirectChat: boolean;
  /**
   * The chat is a kind the product serves: a direct chat or a room. A
   * broadcast feed is neither.
   */
  chatSupported: boolean;
  /**
   * The room is one the operator allows. Only a legacy Discord install with
   * a persisted allow-list ever fences a room off; every other channel
   * passes `true`.
   */
  roomAllowed: boolean;
  /**
   * Whether the message addresses the bot, as the channel proves it: a
   * mention by name or id, or a reply to one of its posts where the
   * platform carries one. `undefined` when the channel could not evaluate it
   * because it does not yet know the bot's own identity.
   */
  addressesBot: boolean | undefined;
}

export type RoomAdmissionDropReason =
  | "self_authored"
  | "bot_authored"
  | "chat_not_supported"
  | "room_not_allowed"
  | "bot_identity_unknown"
  | "bot_not_mentioned";

export type RoomAdmissionVerdict =
  | {
      admitted: true;
      /**
       * Whether the message addresses the bot by name or by reply. In a room
       * this is always true, since nothing else is admitted; in a direct chat
       * it says whether the person typed the bot's name.
       */
      botMentioned: boolean;
    }
  | { admitted: false; reason: RoomAdmissionDropReason };

function drop(reason: RoomAdmissionDropReason): RoomAdmissionVerdict {
  return { admitted: false, reason };
}

/**
 * Decide whether a message is one the gateway acts on. Checks run
 * cheapest-and-most-decisive first.
 */
export function admitRoomMessage(
  candidate: RoomAdmissionCandidate,
): RoomAdmissionVerdict {
  // The bot's own posts and other machines' traffic drop before anything
  // else: processing either is how a reply loop starts.
  if (candidate.authorIsSelf) {
    return drop("self_authored");
  }
  if (candidate.authorIsBot) {
    return drop("bot_authored");
  }

  // A direct chat needs no mention to be meant for the bot; nobody @-s a bot
  // in its own DM. The chat is admitted, and whether this person is answered
  // is the runtime's floor to decide.
  if (candidate.isDirectChat) {
    return { admitted: true, botMentioned: candidate.addressesBot === true };
  }

  if (!candidate.chatSupported) {
    return drop("chat_not_supported");
  }

  if (!candidate.roomAllowed) {
    return drop("room_not_allowed");
  }

  // Without its own identity the gate cannot tell an addressed room message
  // from any other, and admitting every message is the one thing it must
  // never do.
  if (candidate.addressesBot === undefined) {
    return drop("bot_identity_unknown");
  }

  if (!candidate.addressesBot) {
    return drop("bot_not_mentioned");
  }

  return { admitted: true, botMentioned: true };
}

/**
 * The level each reason logs at on its first occurrence for a room, shared
 * by every channel that runs this verdict. Each channel spreads it into its
 * own severity table beside the reasons only it produces.
 *
 * `bot_not_mentioned` is a person making a room remark that does not address
 * the bot. It is not a fault, but it is evidence that events reach the
 * gateway at all, which is the fact a person debugging a quiet room needs.
 * `room_not_allowed` is the configured behaviour of a legacy allow-list
 * rather than a fault, so it surfaces like ordinary denied traffic.
 * `chat_not_supported` and `bot_identity_unknown` are the two a person or
 * operator can act on.
 *
 * `self_authored` and `bot_authored` never promote. They are the bot's own
 * echo and other machines' traffic, they scale with how chatty a room is, and
 * no misconfiguration produces them, so a visible line would carry no signal.
 */
export const ROOM_ADMISSION_DROP_LOG_SEVERITY: Readonly<
  Record<RoomAdmissionDropReason, AdmissionDropLogLevel>
> = {
  bot_not_mentioned: "info",
  room_not_allowed: "info",
  chat_not_supported: "info",
  bot_identity_unknown: "info",
  self_authored: "debug",
  bot_authored: "debug",
};
