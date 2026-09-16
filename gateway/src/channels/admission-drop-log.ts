/**
 * Log-level policy for messages a channel drops before they reach the
 * runtime, whether an admission gate denied them or a normalizer could not
 * shape them.
 *
 * Severity and volume are separate questions, and this module answers them
 * separately.
 *
 * Severity splits by reason, in a table each channel supplies. One drop means
 * an operator misconfigured something, some mean a person aimed a message
 * somewhere policy does not serve, and the rest are machine traffic the gate
 * exists to swallow. Only the first two kinds are worth an operator's
 * attention.
 *
 * Volume is capped by promoting only the first drop for a given reason and
 * conversation; repeats log at `debug`. One dropped message carries the whole
 * diagnosis, since the reason names the check that failed and the
 * conversation names where, so later identical drops add nothing.
 *
 * Both matter because every gateway log stream is built at `level: "info"`
 * (see `logger.ts`). A `debug` line reaches no sink, so a gate that denies
 * every message while logging only at `debug` is indistinguishable from a
 * gateway receiving nothing. A gate that promotes every drop is equally
 * useless in the other direction: a bot in a community server sees every
 * message in every room it can view, and promoting all of them floods the
 * stream the gate exists to keep quiet.
 */

/** Levels this policy selects between. Both exist on the gateway logger. */
export type AdmissionDropLogLevel = "info" | "debug";

/**
 * Conversations tracked per reason before that reason stops promoting.
 *
 * The budget is per reason rather than shared because reasons differ in key
 * cardinality, and a shared budget would let a flood of one reason exhaust
 * it and silence another. Separate budgets mean a flood of one reason can
 * only ever silence itself.
 */
const MAX_TRACKED_CONVERSATIONS_PER_REASON = 512;

export class AdmissionDropLog<Reason extends string> {
  private readonly seen = new Map<Reason, Set<string>>();

  /**
   * @param severity The level each reason logs at on its first occurrence
   *   for a conversation. A reason mapped to `debug` never promotes.
   */
  constructor(
    private readonly severity: Readonly<Record<Reason, AdmissionDropLogLevel>>,
  ) {}

  /**
   * The level this drop logs at.
   *
   * `conversationId` is the dedup key: calling this records the drop, so a
   * promotable reason is promoted once per conversation and every repeat is
   * `debug`. Reasons that never promote consume no budget.
   *
   * A drop that cannot name a conversation (a payload the schema rejected, a
   * message with no chat) passes `undefined` and is promoted every time.
   * There is nothing to dedup it on, and collapsing every occurrence onto one
   * shared key would let a wave of them weeks into a process log once and
   * then vanish. The volume is bounded by the ingress itself: every channel
   * authenticates its sender before a drop can be recorded, so only the
   * platform can produce them.
   */
  levelFor(
    reason: Reason,
    conversationId: string | undefined,
  ): AdmissionDropLogLevel {
    const severity = this.severity[reason];
    if (severity === "debug") {
      return "debug";
    }
    if (conversationId === undefined) {
      return severity;
    }

    let conversations = this.seen.get(reason);
    if (!conversations) {
      conversations = new Set();
      this.seen.set(reason, conversations);
    }
    if (
      conversations.has(conversationId) ||
      conversations.size >= MAX_TRACKED_CONVERSATIONS_PER_REASON
    ) {
      return "debug";
    }
    conversations.add(conversationId);
    return severity;
  }
}
