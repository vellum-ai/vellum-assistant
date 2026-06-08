// Accumulates counts of requests served via the legacy loopback auth fallback,
// keyed by (guard, path, failureKind). The auth hot path calls `increment`
// (an O(1) Map bump, no I/O); a background reporter periodically `drain`s the
// accumulated counts and ships them to the daemon telemetry route. This is the
// data complement to AuthFallbackLogThrottle's throttled log line: the log is a
// sampled human signal, these counts are the exact volume.

import { getLogger } from "./logger.js";

const log = getLogger("auth-fallback-tracker");

// Bounds memory if a caller floods distinct paths. Cardinality is normally
// tiny (edge routes × failure kinds), so this only trips under abuse.
const MAX_TRACKED_KEYS = 10_000;

// Composite-key separator, mirroring AuthFallbackLogThrottle's `${guard} ${path}`
// key. Safe because guard values are fixed slugs, URL pathnames percent-encode
// spaces, and failureKind values are underscore tokens — none contain a space.
const SEP = " ";

/** One aggregated count for a single (guard, path, failureKind). */
export interface AuthFallbackCount {
  guard: string;
  path: string;
  failureKind: string;
  count: number;
}

/** A drained window of counts, ready to ship. */
export interface AuthFallbackBatch {
  windowStart: number;
  windowEnd: number;
  counts: AuthFallbackCount[];
}

export class AuthFallbackCountTracker {
  private counts = new Map<string, AuthFallbackCount>();
  private windowStartedAt: number;
  private warnedAtCap = false;

  constructor(now: number = Date.now()) {
    this.windowStartedAt = now;
  }

  /** Record one fallback. O(1), no I/O — safe on the auth hot path. */
  increment(guard: string, path: string, failureKind: string): void {
    this.add(guard, path, failureKind, 1);
  }

  /**
   * Drain and reset the accumulated counts. Returns the window covered and the
   * per-key counts. When nothing was tracked the window start is left anchored
   * (an empty drain doesn't shift the accumulation window).
   */
  drain(now: number = Date.now()): AuthFallbackBatch {
    const counts = [...this.counts.values()];
    const windowStart = this.windowStartedAt;
    if (counts.length === 0) {
      return { windowStart, windowEnd: now, counts };
    }
    this.counts = new Map();
    this.windowStartedAt = now;
    this.warnedAtCap = false;
    return { windowStart, windowEnd: now, counts };
  }

  /**
   * Fold a previously-drained batch back in — used by the reporter to avoid
   * losing a window when the daemon POST fails. Subject to the same key cap.
   */
  merge(counts: AuthFallbackCount[]): void {
    for (const c of counts) {
      this.add(c.guard, c.path, c.failureKind, c.count);
    }
  }

  /** Read-only view of the current counts (for tests/inspection). */
  snapshot(): AuthFallbackCount[] {
    return [...this.counts.values()].map((c) => ({ ...c }));
  }

  /** Clear all state (for test isolation). */
  reset(now: number = Date.now()): void {
    this.counts = new Map();
    this.windowStartedAt = now;
    this.warnedAtCap = false;
  }

  private add(
    guard: string,
    path: string,
    failureKind: string,
    delta: number,
  ): void {
    const key = `${guard}${SEP}${path}${SEP}${failureKind}`;
    const existing = this.counts.get(key);
    if (existing) {
      existing.count += delta;
      return;
    }
    if (this.counts.size >= MAX_TRACKED_KEYS) {
      if (!this.warnedAtCap) {
        this.warnedAtCap = true;
        log.warn(
          { maxKeys: MAX_TRACKED_KEYS },
          "Auth-fallback tracker at key cap — new (guard, path, failureKind) keys dropped until next flush",
        );
      }
      return;
    }
    this.counts.set(key, { guard, path, failureKind, count: delta });
  }
}
