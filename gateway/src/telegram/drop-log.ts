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
 * `chat_not_private` is the one a person can act on: they added the bot to a
 * group and their messages are not arriving, and this line is the only place
 * that says so, since Telegram sees a 200 either way. The malformed-shape
 * reasons promote because a well-formed Bot API update never produces them,
 * so any occurrence is worth a look.
 *
 * `no_supported_content` is ordinary traffic: a sticker, a location, a
 * contact card. The bot is not built to read them and nothing is
 * misconfigured. The callback edge cases are inline-mode artifacts of the
 * same kind.
 */
const DROP_LOG_SEVERITY: Record<TelegramDropReason, AdmissionDropLogLevel> = {
  chat_not_private: "info",
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
