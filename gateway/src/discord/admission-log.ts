/**
 * Log-level policy for admission-gate drops.
 *
 * Two failure modes pull in opposite directions here.
 *
 * Logging every drop at `debug` is what shipped, and it hides the gate
 * completely: every gateway log stream is built at `level: "info"` (see
 * `logger.ts`), so a `debug` line is never written to any sink. A gate that
 * denies every message while emitting nothing is indistinguishable from a
 * gateway that receives nothing. That is how an empty allow-list read as "no
 * events ever arrived" during the Jul 30 smoke test, and it produced four
 * wrong root-cause hypotheses before anyone looked at the stored config.
 *
 * Logging every drop at `info` is the opposite problem. The gate denies by
 * design, and a bot in a community guild sees every message in every channel
 * it can view. Promoting all of them floods the stream the gate exists to keep
 * quiet.
 *
 * The policy has two parts, because volume and signal are different questions.
 *
 * Severity splits by reason ({@link DROP_LOG_SEVERITY}). Not every denial is
 * worth the same attention: one of them means an operator misconfigured
 * something, some mean a person aimed a message somewhere policy does not
 * serve, and the rest are machine traffic the gate exists to swallow.
 *
 * Volume is bounded by promoting only the first drop for a given reason and
 * channel; repeats fall to `debug`. One denied message carries the whole
 * diagnosis, since the reason names the check that failed and the channel
 * names where, so nothing is lost by staying quiet afterwards.
 */

import type { AdmissionDropReason } from "./admit.js";

/** Levels this policy selects between. All three exist on the gateway logger. */
export type AdmissionDropLogLevel = "warn" | "info" | "debug";

/**
 * The level a reason logs at on its first occurrence for a channel.
 *
 * `channel_not_allowed` is the only operator-actionable denial. It fires when
 * a channel is missing from the allow-list, when the setting is stored in a
 * shape the reader cannot use, or when a snowflake is malformed. In every one
 * of those cases a human meant for the bot to work somewhere and it silently
 * does not, so it warns.
 *
 * `not_a_guild_message` and `bot_not_mentioned` are a person aiming a message
 * somewhere this client deliberately does not serve, either a DM or a channel
 * remark that does not address the bot. Neither is a fault, but both prove
 * events are flowing, which is exactly the evidence the smoke test lacked.
 *
 * `self_authored` and `bot_authored` never promote. They are the bot's own
 * echo and other machines' traffic, they scale with how chatty the room is,
 * and no operator ever needs to see one. They are also the two whose absence
 * costs nothing diagnostically: neither can be caused by a misconfiguration.
 */
const DROP_LOG_SEVERITY: Record<AdmissionDropReason, AdmissionDropLogLevel> = {
  channel_not_allowed: "warn",
  not_a_guild_message: "info",
  bot_not_mentioned: "info",
  self_authored: "debug",
  bot_authored: "debug",
};

/**
 * Distinct reason-and-channel pairs tracked before promotion stops.
 *
 * Bounds memory against a guild with a large or growing channel count. Past
 * the cap every drop logs at `debug`, which is the behavior this module
 * replaces, so exhausting it degrades to the old quiet rather than to
 * unbounded growth.
 */
const MAX_TRACKED_DROPS = 512;

export class AdmissionDropLog {
  private readonly seen = new Set<string>();

  /**
   * The level this drop logs at.
   *
   * Calling this records the drop, so a promotable reason is promoted once per
   * channel and every repeat afterwards is `debug`. Reasons that never promote
   * consume no tracking slot.
   */
  levelFor(
    reason: AdmissionDropReason,
    channelId: string,
  ): AdmissionDropLogLevel {
    const severity = DROP_LOG_SEVERITY[reason];
    if (severity === "debug") {
      return "debug";
    }
    const key = `${reason}:${channelId}`;
    if (this.seen.has(key) || this.seen.size >= MAX_TRACKED_DROPS) {
      return "debug";
    }
    this.seen.add(key);
    return severity;
  }
}
