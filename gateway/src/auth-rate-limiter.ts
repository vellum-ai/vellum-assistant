// Sliding-window rate limiter for authentication failures.
// Tracks failed attempts per IP and blocks IPs that exceed the threshold.

const DEFAULT_MAX_FAILURES = 10;
const DEFAULT_WINDOW_MS = 60_000; // 60 seconds
const MAX_TRACKED_IPS = 50_000;

export class AuthRateLimiter {
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

  /** Record a failed auth attempt for the given IP. */
  recordFailure(ip: string): void {
    const now = Date.now();
    let timestamps = this.failures.get(ip);

    if (!timestamps) {
      if (this.failures.size >= MAX_TRACKED_IPS) {
        this.evictStale(now);
        // Hard-cap: if still at capacity after eviction, drop the oldest entry
        if (this.failures.size >= MAX_TRACKED_IPS) {
          const oldest = this.failures.keys().next().value;
          if (oldest !== undefined) this.failures.delete(oldest);
        }
      }
      timestamps = [];
      this.failures.set(ip, timestamps);
    }

    timestamps.push(now);
  }

  /** Returns true if the IP has exceeded the failure threshold. */
  isBlocked(ip: string): boolean {
    const timestamps = this.failures.get(ip);
    if (!timestamps) return false;

    const now = Date.now();
    const cutoff = now - this.windowMs;

    // Remove expired timestamps from the front
    while (timestamps.length > 0 && timestamps[0] <= cutoff) {
      timestamps.shift();
    }

    if (timestamps.length === 0) {
      this.failures.delete(ip);
      return false;
    }

    return timestamps.length >= this.maxFailures;
  }

  /** Clear all state on a successful auth (optional — reduces false positives after rotation). */
  clearIp(ip: string): void {
    this.failures.delete(ip);
  }

  private evictStale(now: number): void {
    const cutoff = now - this.windowMs;
    for (const [ip, timestamps] of this.failures) {
      // Remove expired entries from front
      while (timestamps.length > 0 && timestamps[0] <= cutoff) {
        timestamps.shift();
      }
      if (timestamps.length === 0) {
        this.failures.delete(ip);
      }
    }
  }
}
