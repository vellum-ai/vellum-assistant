// Throttles the "served via legacy loopback fallback" warning so each distinct
// endpoint logs at most once per cooldown window. This only controls log
// volume — it never affects the auth decision. Keyed on `${guard} ${path}`,
// whose cardinality is bounded by the number of edge routes, so the map stays
// tiny in normal operation; the safety valve only matters if a caller spams
// many distinct paths.

const DEFAULT_COOLDOWN_MS = 60 * 60 * 1000; // 1 hour
const MAX_TRACKED_KEYS = 10_000;

export class AuthFallbackLogThrottle {
  private lastLogged = new Map<string, number>();
  private readonly cooldownMs: number;

  constructor(cooldownMs = DEFAULT_COOLDOWN_MS) {
    this.cooldownMs = cooldownMs;
  }

  /**
   * Returns true if the caller should emit a log line for this key now, false
   * if one was already emitted within the cooldown window. Records the
   * timestamp on every true result so subsequent calls within the window are
   * suppressed. `now` is injectable for tests.
   */
  shouldLog(key: string, now: number = Date.now()): boolean {
    const last = this.lastLogged.get(key);
    if (last !== undefined) {
      if (now - last < this.cooldownMs) return false;
      // Expired — remove stale entry before re-inserting below.
      this.lastLogged.delete(key);
    }

    // Safety valve: bound memory if an unexpected flood of distinct keys
    // accumulates (e.g. a caller varying the request path). Purge expired
    // entries in bulk, then hard-cap by dropping the oldest.
    if (this.lastLogged.size >= MAX_TRACKED_KEYS) {
      for (const [k, ts] of this.lastLogged) {
        if (now - ts >= this.cooldownMs) this.lastLogged.delete(k);
      }
      if (this.lastLogged.size >= MAX_TRACKED_KEYS) {
        const sorted = [...this.lastLogged.entries()].sort(
          (a, b) => a[1] - b[1],
        );
        const toRemove = sorted.length - MAX_TRACKED_KEYS + 1; // +1 for the incoming entry
        for (let i = 0; i < toRemove; i++) {
          this.lastLogged.delete(sorted[i][0]);
        }
      }
    }

    this.lastLogged.set(key, now);
    return true;
  }
}
