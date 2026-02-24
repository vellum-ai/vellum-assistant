// Rate limiter for routing rejection notices — at most one reply per
// recipient within the cooldown window to avoid spamming the user.

const REJECTION_NOTICE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_REJECTION_CACHE_SIZE = 10_000;
const SWEEP_INTERVAL = 100; // sweep every N calls

export class RejectionRateLimiter {
  private timestamps = new Map<string, number>();
  private callCount = 0;

  /**
   * Returns true if a rejection notice should be sent for this recipient,
   * false if one was already sent within the cooldown window.
   * Records the current timestamp so subsequent calls within the window
   * return false.
   */
  shouldSend(recipientId: string): boolean {
    const now = Date.now();

    this.callCount++;
    if (this.callCount >= SWEEP_INTERVAL) {
      this.callCount = 0;
      this.sweep(now);
    }

    const lastSent = this.timestamps.get(recipientId);
    if (lastSent !== undefined && now - lastSent < REJECTION_NOTICE_COOLDOWN_MS) {
      return false;
    }
    this.timestamps.set(recipientId, now);
    return true;
  }

  /**
   * Evict expired entries. If the map still exceeds the max size after
   * removing stale entries, drop the oldest entries until it fits.
   */
  private sweep(now: number): void {
    for (const [key, ts] of this.timestamps) {
      if (now - ts >= REJECTION_NOTICE_COOLDOWN_MS) {
        this.timestamps.delete(key);
      }
    }

    if (this.timestamps.size > MAX_REJECTION_CACHE_SIZE) {
      const sorted = [...this.timestamps.entries()].sort((a, b) => a[1] - b[1]);
      const toRemove = sorted.length - MAX_REJECTION_CACHE_SIZE;
      for (let i = 0; i < toRemove; i++) {
        this.timestamps.delete(sorted[i][0]);
      }
    }
  }
}
