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

  /** Store a response for the given update_id. */
  set(updateId: number, body: string, status: number): void {
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
 */
export class StringDedupCache {
  private cache = new Map<string, number>();
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
    const now = Date.now();
    const expiresAt = this.cache.get(key);
    if (expiresAt !== undefined) {
      if (now <= expiresAt) return true;
      this.cache.delete(key);
    }

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
    return false;
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
