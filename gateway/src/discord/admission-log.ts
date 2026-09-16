/**
 * Discord's severity table for admission-gate drops. The policy itself (one
 * promoted line per reason and channel, repeats at debug) is the shared
 * `AdmissionDropLog` in `channels/admission-drop-log.ts`.
 */

import {
  AdmissionDropLog,
  type AdmissionDropLogLevel,
} from "../channels/admission-drop-log.js";
import type { AdmissionDropReason } from "./admit.js";

/**
 * The level a reason logs at on its first occurrence for a channel.
 *
 * Every remaining reason is ordinary traffic rather than a misconfiguration:
 * which rooms the bot can see is Discord's decision, expressed as channel
 * permissions, so a message it never receives produces no denial here to log.
 *
 * `bot_not_mentioned` is a person making a channel remark that does not
 * address the bot. It is not a fault, but it is evidence that events reach the
 * client at all.
 *
 * `channel_not_allowed` exists only under a legacy install's persisted
 * allow-list, where dropping unlisted rooms is the configured behavior
 * rather than a fault, so it surfaces like ordinary denied traffic.
 *
 * `self_authored` and `bot_authored` never promote. They are the bot's own
 * echo and other machines' traffic, they scale with how chatty a room is, and
 * no misconfiguration produces them, so a visible line would carry no signal.
 */
const DROP_LOG_SEVERITY: Record<AdmissionDropReason, AdmissionDropLogLevel> = {
  bot_not_mentioned: "info",
  channel_not_allowed: "info",
  self_authored: "debug",
  bot_authored: "debug",
};

export function createDiscordAdmissionDropLog(): AdmissionDropLog<AdmissionDropReason> {
  return new AdmissionDropLog(DROP_LOG_SEVERITY);
}
