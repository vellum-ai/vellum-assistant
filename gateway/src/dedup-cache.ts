import { getLogger } from "./logger.js";

const log = getLogger("dedup-cache");

interface CacheEntry {
  body: string;
  status: number;
  expiresAt: number;
  /** When true, the first handler is still processing this update_id. */
  processing?: boolean;
}

/**
 * In-memory TTL cache for Telegram update_id deduplication.
 * Prevents redundant normalization, routing, attachment downloads,
 * and runtime forwarding when Telegram retries a webhook on timeout.
 */
export class DedupCache {
  private cache = new Map<number, CacheEntry>();
  private readonly ttlMs: number;
  private readonly maxSize: number;
  /**
   * Monotonic high-water mark: the highest update_id that has been fully
   * processed (finalized via set()). Any update_id at or below this value
   * is rejected permanently, even after the TTL cache evicts the entry.
   * This closes the replay window that existed when entries expired from
   * the TTL cache.
   */
  private highWaterMark = -Infinity;

  constructor(ttlMs = 5 * 60_000, maxSize = 10_000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  /**
   * Returns the cached response body+status if the update_id was already seen
   * and processing has completed. Returns `undefined` for entries still being
   * processed (reserved but not yet finalized).
   */
  get(updateId: number): { body: string; status: number } | undefined {
    const entry = this.cache.get(updateId);
    if (!entry) return undefined;
    if (Date.now() > entry.expiresAt) {
      this.cache.delete(updateId);
      return undefined;
    }
    if (entry.processing) return undefined;
    return { body: entry.body, status: entry.status };
  }

  /**
   * Checks whether this update_id is already reserved or cached.
   * If not, immediately reserves it with a "processing" sentinel so that
   * concurrent retries are blocked before the handler finishes.
   * Returns true if a new reservation was created (caller should proceed),
   * false if the update_id was already present (caller should short-circuit).
   *
   * While the entry is in the "processing" state, {@link get} returns
   * `undefined` so callers can distinguish an in-flight request from a
   * finalized cache hit and respond accordingly (e.g. 503 Retry-After).
   */
  reserve(updateId: number): boolean {
    // Reject any update_id at or below the high-water mark — these have
    // already been fully processed and are replay attempts.
    if (updateId <= this.highWaterMark) {
      return false;
    }

    const existing = this.cache.get(updateId);
    if (existing && Date.now() <= existing.expiresAt) {
      return false;
    }
    // Clean up expired entry if present
    if (existing) this.cache.delete(updateId);

    // Evict if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictExpired();
    }
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    this.cache.set(updateId, {
      body: "",
      status: 0,
      expiresAt: Date.now() + this.ttlMs,
      processing: true,
    });
    return true;
  }

  /** Remove a reserved entry so Telegram can retry. */
  unreserve(updateId: number): void {
    const entry = this.cache.get(updateId);
    if (entry?.processing) {
      this.cache.delete(updateId);
    }
  }

  /** Store a response for the given update_id and advance the high-water mark. */
  set(updateId: number, body: string, status: number): void {
    // Advance monotonic high-water mark so this update_id (and all lower
    // ones) are permanently rejected even after the TTL cache evicts them.
    if (updateId > this.highWaterMark) {
      this.highWaterMark = updateId;
    }

    // Evict expired entries if we're at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictExpired();
    }
    // If still at capacity after eviction, drop the oldest entry
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    this.cache.set(updateId, {
      body,
      status,
      expiresAt: Date.now() + this.ttlMs,
    });
  }

  get size(): number {
    return this.cache.size;
  }

  private evictExpired(): void {
    const now = Date.now();
    let evicted = 0;
    for (const [key, entry] of this.cache) {
      if (now > entry.expiresAt) {
        this.cache.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      log.debug({ evicted }, "Evicted expired dedup cache entries");
    }
  }
}

/**
 * Simple string-keyed TTL set for deduplication.
 * Used for SMS MessageSid dedup where we only need to track whether
 * a message ID has been seen, not cache a full response.
 *
 * Supports a reserve/unreserve pattern to prevent concurrent duplicates
 * during async processing windows (matching the DedupCache pattern used
 * by the Telegram webhook).
 */
export class StringDedupCache {
  private cache = new Map<string, number>();
  /** Keys that have been reserved but not yet finalized via mark(). */
  private processing = new Set<string>();
  private readonly ttlMs: number;
  private readonly maxSize: number;

  constructor(ttlMs = 5 * 60_000, maxSize = 10_000) {
    this.ttlMs = ttlMs;
    this.maxSize = maxSize;
  }

  /**
   * Returns true if the key has already been seen (within the TTL window).
   * If not seen, marks it as seen and returns false.
   */
  seen(key: string): boolean {
    if (this.has(key)) return true;
    this.mark(key);
    return false;
  }

  /**
   * Returns true if the key is already in the cache (within the TTL window)
   * or is currently reserved for processing. Use this for a read-only check.
   */
  has(key: string): boolean {
    if (this.processing.has(key)) return true;
    const now = Date.now();
    const expiresAt = this.cache.get(key);
    if (expiresAt !== undefined) {
      if (now <= expiresAt) return true;
      this.cache.delete(key);
    }
    return false;
  }

  /**
   * Atomically checks whether a key is already reserved or cached, and if
   * not, claims it so concurrent requests for the same key are blocked.
   * Returns true if a new reservation was created (caller should proceed),
   * false if the key was already present (caller should short-circuit).
   *
   * Call {@link mark} after successful processing to finalize, or
   * {@link unreserve} on failure so retries are not blocked.
   */
  reserve(key: string): boolean {
    if (this.has(key)) return false;
    this.processing.add(key);
    return true;
  }

  /**
   * Remove a reserved-but-not-finalized key so that retries are not blocked
   * after a processing failure.
   */
  unreserve(key: string): void {
    this.processing.delete(key);
  }

  /**
   * Marks a key as seen. Call this after successful processing to prevent
   * future duplicates while still allowing retries on failure.
   * Also clears any in-flight reservation for the key.
   */
  mark(key: string): void {
    this.processing.delete(key);
    const now = Date.now();

    // Evict expired entries if at capacity
    if (this.cache.size >= this.maxSize) {
      this.evictExpired(now);
    }
    if (this.cache.size >= this.maxSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }

    this.cache.set(key, now + this.ttlMs);
  }

  get size(): number {
    return this.cache.size;
  }

  private evictExpired(now: number): void {
    let evicted = 0;
    for (const [key, expiresAt] of this.cache) {
      if (now > expiresAt) {
        this.cache.delete(key);
        evicted++;
      }
    }
    if (evicted > 0) {
      log.debug({ evicted }, "Evicted expired string dedup cache entries");
    }
  }
}
