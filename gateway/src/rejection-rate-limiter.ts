// Rate limiter for routing rejection notices — at most one reply per
// recipient within the cooldown window to avoid spamming the user.

const REJECTION_NOTICE_COOLDOWN_MS = 5 * 60 * 1000; // 5 minutes
const MAX_REJECTION_CACHE_SIZE = 10_000;

export class RejectionRateLimiter {
  private timestamps = new Map<string, number>();

  /**
   * Returns true if a rejection notice should be sent for this recipient,
   * false if one was already sent within the cooldown window.
   * Records the current timestamp so subsequent calls within the window
   * return false.
   */
  shouldSend(recipientId: string): boolean {
    const now = Date.now();

    const lastSent = this.timestamps.get(recipientId);
    if (lastSent !== undefined) {
      if (now - lastSent < REJECTION_NOTICE_COOLDOWN_MS) {
        return false;
      }
      // Expired — remove stale entry before re-inserting below
      this.timestamps.delete(recipientId);
    }

    // Safety valve: if too many unique recipients accumulate, purge expired
    // entries in bulk. This only fires in degenerate cases (10k+ distinct
    // recipients within 5 minutes) and keeps memory bounded.
    if (this.timestamps.size >= MAX_REJECTION_CACHE_SIZE) {
      for (const [key, ts] of this.timestamps) {
        if (now - ts >= REJECTION_NOTICE_COOLDOWN_MS) {
          this.timestamps.delete(key);
        }
      }
      // Hard cap: if still over limit after purging expired entries,
      // drop the oldest entries until we're under the limit.
      if (this.timestamps.size >= MAX_REJECTION_CACHE_SIZE) {
        const sorted = [...this.timestamps.entries()].sort(
          (a, b) => a[1] - b[1],
        );
        const toRemove = sorted.length - MAX_REJECTION_CACHE_SIZE + 1; // +1 for the incoming entry
        for (let i = 0; i < toRemove; i++) {
          this.timestamps.delete(sorted[i][0]);
        }
      }
    }

    this.timestamps.set(recipientId, now);
    return true;
  }
}
