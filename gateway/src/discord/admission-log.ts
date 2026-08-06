/**
 * Log-level policy for admission-gate drops.
 *
 * Severity and volume are separate questions, and this module answers them
 * separately.
 *
 * Severity splits by reason ({@link DROP_LOG_SEVERITY}). One denial means an
 * operator misconfigured something, some mean a person aimed a message
 * somewhere policy does not serve, and the rest are machine traffic the gate
 * exists to swallow. Only the first kind is worth an operator's attention.
 *
 * Volume is capped by promoting only the first drop for a given reason and
 * channel; repeats log at `debug`. One denied message carries the whole
 * diagnosis, since the reason names the check that failed and the channel
 * names where, so later identical drops add nothing.
 *
 * Both matter because every gateway log stream is built at `level: "info"`
 * (see `logger.ts`). A `debug` line reaches no sink, so a gate that denies
 * every message while logging only at `debug` is indistinguishable from a
 * gateway receiving nothing. A gate that promotes every denial is equally
 * useless in the other direction: a bot in a community guild sees every
 * message in every channel it can view, and promoting all of them floods the
 * stream the gate exists to keep quiet.
 */

import type { AdmissionDropReason } from "./admit.js";

/** Levels this policy selects between. All three exist on the gateway logger. */
export type AdmissionDropLogLevel = "warn" | "info" | "debug";

/**
 * The level a reason logs at on its first occurrence for a channel.
 *
 * `channel_not_allowed` is the only operator-actionable denial. It fires when
 * a channel is missing from the allow-list, when the setting holds a shape the
 * reader cannot use, or when a snowflake is malformed. In each case a human
 * intends the bot to work somewhere and it silently does not, so it warns.
 *
 * `not_a_guild_message` and `bot_not_mentioned` are a person aiming a message
 * somewhere this client does not serve, either a DM or a channel remark that
 * does not address the bot. Neither is a fault, but both are evidence that
 * events reach the client at all.
 *
 * `self_authored` and `bot_authored` never promote. They are the bot's own
 * echo and other machines' traffic, they scale with how chatty a room is, and
 * no misconfiguration produces them, so a visible line would carry no signal.
 */
const DROP_LOG_SEVERITY: Record<AdmissionDropReason, AdmissionDropLogLevel> = {
  channel_not_allowed: "warn",
  not_a_guild_message: "info",
  bot_not_mentioned: "info",
  self_authored: "debug",
  bot_authored: "debug",
};

/**
 * Channels tracked per reason before that reason stops promoting.
 *
 * The budget is per reason rather than shared because reasons differ in key
 * cardinality. Guild-channel reasons are bounded by how many channels the bot
 * can view, but `not_a_guild_message` is keyed on a DM channel, which is
 * unique per sender and so unbounded by anyone outside the guild. A shared
 * budget lets a stream of DMs exhaust it and silence `channel_not_allowed`,
 * the one reason an operator needs. Separate budgets mean a flood of one
 * reason can only ever silence itself.
 */
const MAX_TRACKED_CHANNELS_PER_REASON = 512;

export class AdmissionDropLog {
  private readonly seen = new Map<AdmissionDropReason, Set<string>>();

  /**
   * The level this drop logs at.
   *
   * Calling this records the drop, so a promotable reason is promoted once per
   * channel and every repeat is `debug`. Reasons that never promote consume no
   * budget.
   */
  levelFor(
    reason: AdmissionDropReason,
    channelId: string,
  ): AdmissionDropLogLevel {
    const severity = DROP_LOG_SEVERITY[reason];
    if (severity === "debug") {
      return "debug";
    }

    let channels = this.seen.get(reason);
    if (!channels) {
      channels = new Set();
      this.seen.set(reason, channels);
    }
    if (
      channels.has(channelId) ||
      channels.size >= MAX_TRACKED_CHANNELS_PER_REASON
    ) {
      return "debug";
    }
    channels.add(channelId);
    return severity;
  }
}
