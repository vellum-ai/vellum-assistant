/**
 * Reconnect pacing for the Discord Gateway client.
 *
 * Discord caps IDENTIFY at 1000 per 24 hours, and breaching the cap does not
 * merely throttle — it terminates every session and **resets the bot token**,
 * which takes the integration down until a human stores a new one. That makes
 * reconnect pacing a credential-safety mechanism rather than a politeness one,
 * and it is why this is a module with tests instead of two constants inline.
 *
 * Three rules follow from it, and each one differs from the Slack Socket Mode
 * client this codebase otherwise models Discord on:
 *
 * 1. **Backoff resets on a stable session, never on socket-open.** Slack resets
 *    its attempt counter in the `open` handler. Here that is the bug that
 *    empties the budget: a socket that opens and immediately dies would reset
 *    the delay every cycle, turning an outage into a tight identify loop. Only
 *    `noteSessionStable()` — called once a session has held past
 *    {@link SESSION_STABLE_AFTER_MS} — clears it.
 * 2. **Full jitter, not additive.** Slack adds 0–50% to the delay. Full jitter
 *    spreads retries across the whole window, which matters when several
 *    instances recover from one Discord-side outage together.
 * 3. **The identify cap is derived from the budget, not chosen for feel.**
 */

import { ExponentialBackoff } from "../util/exponential-backoff.js";

/** Delay before the first reconnect attempt. */
const BASE_BACKOFF_MS = 1_000;

/**
 * Ceiling for delays before a RESUME. Resumes do not count against the
 * identify budget, so this is paced for recovery speed, matching Slack.
 */
const RESUME_MAX_BACKOFF_MS = 30_000;

/**
 * Ceiling for delays before an IDENTIFY, derived from the 1000/24h cap.
 *
 * Under full jitter a delay is uniform over `[0, cap)`, so a sustained outage
 * spends roughly `86_400s / (cap / 2)` identifies per day:
 *
 * | cap  | identifies/24h | share of the 1000 budget |
 * | ---- | -------------- | ------------------------ |
 * | 120s | ~1440          | over budget — token reset |
 * | 300s | ~576           | 58%                      |
 * | 600s | ~288           | 29%                      |
 *
 * A two-minute ceiling reads as conservative — it is four times Slack's — and
 * still exceeds the cap. Ten minutes leaves room for the retries that fatal
 * close codes and op 9 handling cannot pre-empt. The cost is slower recovery
 * from a long outage, which is the right trade against a token reset.
 */
const IDENTIFY_MAX_BACKOFF_MS = 600_000;

/**
 * How long a session must hold before it counts as stable.
 *
 * READY or RESUMED alone is not enough: a session that dies seconds later is
 * exactly the flap this pacing exists to survive, and treating its arrival as
 * success would reset the delay on every cycle.
 */
export const SESSION_STABLE_AFTER_MS = 120_000;

export type RecoveryKind = "resume" | "identify";

/**
 * Consecutive-failure pacing for reconnects: the shared full-jitter
 * exponential core plus Discord's two rules on top of it, a per-kind delay
 * ceiling and a reset gated on session stability rather than socket-open.
 */
export class ReconnectBackoff {
  private readonly backoff: ExponentialBackoff;

  /** `random` is injectable so tests can pin the jitter. */
  constructor(random: () => number = Math.random) {
    this.backoff = new ExponentialBackoff({
      baseDelayMs: BASE_BACKOFF_MS,
      maxDelayMs: RESUME_MAX_BACKOFF_MS,
      jitter: { mode: "full" },
      random,
    });
  }

  /** Consecutive recovery attempts since the last stable session. */
  get failureCount(): number {
    return this.backoff.attemptCount;
  }

  /**
   * Delay before the next attempt, and count it.
   *
   * A resume failure still raises the count that a later identify reads:
   * repeated resume failures are the same instability signal, and letting the
   * first identify after them start from zero is how a flap reaches the
   * identify path at full speed.
   */
  nextDelayMs(kind: RecoveryKind): number {
    return this.backoff.nextDelayMs({
      maxDelayMs:
        kind === "identify" ? IDENTIFY_MAX_BACKOFF_MS : RESUME_MAX_BACKOFF_MS,
    });
  }

  /**
   * Record that a session has held past {@link SESSION_STABLE_AFTER_MS}. This
   * is the only thing that clears the backoff.
   */
  noteSessionStable(): void {
    this.backoff.reset();
  }
}
