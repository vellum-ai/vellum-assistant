/**
 * Telegram's severity table for updates the normalizer drops. The policy
 * itself (one promoted line per reason and chat, repeats at debug) is the
 * shared `AdmissionDropLog` in `channels/admission-drop-log.ts`.
 */

import {
  AdmissionDropLog,
  type AdmissionDropLogLevel,
} from "../channels/admission-drop-log.js";
import type { TelegramDropReason } from "./normalize.js";

/**
 * The level a reason logs at on its first occurrence for a chat.
 *
 * `bot_not_mentioned` is a person making a room remark that does not address
 * the bot. It is not a fault, but it is evidence that events reach the
 * gateway at all, which is the fact a person debugging a quiet group needs,
 * and this line is the only place that records it, since Telegram sees a 200
 * either way. `chat_not_supported` and `bot_identity_unknown` are the two a
 * person or operator can act on. The malformed-shape reasons promote because
 * a well-formed Bot API update never produces them, so any occurrence is
 * worth a look.
 *
 * `no_supported_content` is ordinary traffic: a sticker, a location, a
 * contact card. The bot is not built to read them and nothing is
 * misconfigured. The callback edge cases are inline-mode artifacts of the
 * same kind. `self_authored` and `bot_authored` never promote for the reason
 * Discord's table gives: they scale with room chatter and no
 * misconfiguration produces them.
 */
const DROP_LOG_SEVERITY: Record<TelegramDropReason, AdmissionDropLogLevel> = {
  bot_not_mentioned: "info",
  chat_not_supported: "info",
  bot_identity_unknown: "info",
  self_authored: "debug",
  bot_authored: "debug",
  malformed_update: "info",
  missing_update_id: "info",
  missing_chat: "info",
  missing_sender: "info",
  no_supported_content: "debug",
  callback_without_message: "debug",
  callback_without_data: "debug",
};

export function createTelegramDropLog(): AdmissionDropLog<TelegramDropReason> {
  return new AdmissionDropLog(DROP_LOG_SEVERITY);
}
