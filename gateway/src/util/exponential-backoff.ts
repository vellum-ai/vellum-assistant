/**
 * Capped exponential backoff with jitter.
 *
 * One counter of consecutive failures drives a delay window of
 * `min(baseDelayMs * 2^attempts, maxDelayMs)`. Two jitter modes cover the
 * gateway's reconnect and retry loops:
 *
 * - `additive`: delay is the full window plus `ratio * random() * window`,
 *   so the window is a floor. Used by loops where a single client paces
 *   itself against its own server allocation (Slack Socket Mode, Velay).
 * - `full`: delay is uniform over `[0, window)`, spreading retries across
 *   the whole window. Used where many instances recovering from one
 *   provider-side outage must not resynchronise (Discord).
 *
 * Stateless with respect to time: the caller owns timers and decides when
 * a connection counts as recovered (via {@link ExponentialBackoff.reset}),
 * so this stays a pure function of attempt count and is testable without
 * waiting.
 */

export type BackoffJitter =
  | { mode: "full" }
  | { mode: "additive"; ratio: number };

export type ExponentialBackoffOptions = {
  /** Window for the first attempt. */
  baseDelayMs: number;
  /** Ceiling the window never exceeds. Overridable per call. */
  maxDelayMs: number;
  jitter: BackoffJitter;
  /** Injectable so tests can pin the jitter. */
  random?: () => number;
};

export class ExponentialBackoff {
  private attempts = 0;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly jitter: BackoffJitter;
  private readonly random: () => number;

  constructor(options: ExponentialBackoffOptions) {
    this.baseDelayMs = options.baseDelayMs;
    this.maxDelayMs = options.maxDelayMs;
    this.jitter = options.jitter;
    this.random = options.random ?? Math.random;
  }

  /** Consecutive attempts since the last {@link reset}. */
  get attemptCount(): number {
    return this.attempts;
  }

  /**
   * Delay before the next attempt, and count it.
   *
   * `maxDelayMs` overrides the constructor ceiling for this call only,
   * for callers whose ceiling depends on the kind of attempt (e.g.
   * Discord resume vs identify) while one failure counter spans both.
   */
  nextDelayMs(overrides?: { maxDelayMs?: number }): number {
    const cap = overrides?.maxDelayMs ?? this.maxDelayMs;
    const window = Math.min(this.baseDelayMs * 2 ** this.attempts, cap);
    this.attempts++;
    if (this.jitter.mode === "full") {
      return Math.round(this.random() * window);
    }
    return Math.round(window + this.jitter.ratio * this.random() * window);
  }

  /** Clear the failure counter. The caller decides what counts as recovery. */
  reset(): void {
    this.attempts = 0;
  }
}
