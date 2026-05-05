// Sliding-window rate limiter for guardian verification attempts.
// Tracks failed verification initiations per identity (phone number, Telegram
// user ID, etc.) and blocks identities that exceed the threshold.
// Modeled after gateway/src/auth-rate-limiter.ts.

const DEFAULT_MAX_FAILURES = 3;
const DEFAULT_WINDOW_MS = 5 * 60_000; // 5 minutes
const MAX_TRACKED_IDENTITIES = 10_000;

class VerificationRateLimiter {
  private failures = new Map<string, number[]>();
  private readonly maxFailures: number;
  private readonly windowMs: number;

  constructor(
    maxFailures = DEFAULT_MAX_FAILURES,
    windowMs = DEFAULT_WINDOW_MS,
  ) {
    this.maxFailures = maxFailures;
    this.windowMs = windowMs;
  }

  /** Record a failed verification attempt for the given identity. */
  recordFailure(identity: string): void {
    const now = Date.now();
    let timestamps = this.failures.get(identity);

    if (!timestamps) {
      if (this.failures.size >= MAX_TRACKED_IDENTITIES) {
        this.evictStale(now);
        if (this.failures.size >= MAX_TRACKED_IDENTITIES) {
          const oldest = this.failures.keys().next().value;
          if (oldest !== undefined) this.failures.delete(oldest);
        }
      }
      timestamps = [];
      this.failures.set(identity, timestamps);
    }

    timestamps.push(now);
  }

  /** Returns true if the identity has exceeded the failure threshold. */
  isBlocked(identity: string): boolean {
    const timestamps = this.failures.get(identity);
    if (!timestamps) return false;

    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Remove expired timestamps from the front
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length === 0) {
      this.failures.delete(identity);
      return false;
    }

    return timestamps.length >= this.maxFailures;
  }

  /** Clear state for an identity on successful verification. */
  clearIdentity(identity: string): void {
    this.failures.delete(identity);
  }

  private evictStale(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [identity, timestamps] of this.failures) {
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.failures.delete(identity);
      }
    }
  }
}

/** Singleton rate limiter for verification endpoint failures. */
export const verificationRateLimiter = new VerificationRateLimiter();
