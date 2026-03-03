/**
 * Inbound A2A message deduplication.
 *
 * Prevents replay and double-delivery of inbound messages by tracking
 * `(connectionId, nonce)` pairs with TTL-based eviction. Follows the
 * same in-memory, bounded-store pattern as `NonceStore` in
 * `a2a-peer-auth.ts` but is keyed on the compound key rather than a
 * single nonce string.
 *
 * The dedup store is intentionally in-memory (no persistence) because
 * the replay window is short and messages that arrive after a daemon
 * restart are treated as fresh. This matches the auth nonce store's
 * threat model.
 */

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Default TTL for dedup entries: 10 minutes. */
export const DEFAULT_DEDUP_TTL_MS = 10 * 60 * 1000;

/** Maximum entries before forced eviction sweep. */
export const MAX_DEDUP_ENTRIES = 10_000;

// ---------------------------------------------------------------------------
// MessageDedupStore
// ---------------------------------------------------------------------------

/**
 * In-memory deduplication store for inbound A2A messages.
 *
 * Keyed by `${connectionId}:${nonce}`. Entries are evicted after `ttlMs`
 * via opportunistic sweeps on `isDuplicate()`, `isKnown()`, and `record()`
 * calls. A hard cap of `MAX_DEDUP_ENTRIES` is enforced after each sweep —
 * if TTL eviction alone doesn't bring the store under capacity, the oldest
 * entries are evicted until below the limit.
 */
export class MessageDedupStore {
  private readonly seen = new Map<string, number>();
  private readonly ttlMs: number;
  private lastSweep: number;

  constructor(ttlMs: number = DEFAULT_DEDUP_TTL_MS) {
    this.ttlMs = ttlMs;
    this.lastSweep = 0;
  }

  /**
   * Build the compound dedup key from connection ID and nonce.
   */
  private static key(connectionId: string, nonce: string): string {
    return `${connectionId}:${nonce}`;
  }

  /**
   * Check whether an inbound message is a duplicate. If not, records
   * the `(connectionId, nonce)` pair and returns `false`. If the pair
   * has been seen within the TTL window, returns `true`.
   *
   * Performs opportunistic sweep of expired entries and enforces the
   * hard capacity cap.
   */
  isDuplicate(connectionId: string, nonce: string, now?: number): boolean {
    const currentTime = now ?? Date.now();

    // Opportunistic sweep: clean up every TTL interval or when over capacity
    if (
      currentTime - this.lastSweep >= this.ttlMs ||
      this.seen.size >= MAX_DEDUP_ENTRIES
    ) {
      this.sweep(currentTime);
      this.evictOldestIfOverCapacity();
    }

    const k = MessageDedupStore.key(connectionId, nonce);

    if (this.seen.has(k)) {
      return true;
    }

    this.seen.set(k, currentTime);
    return false;
  }

  /**
   * Check whether a `(connectionId, nonce)` pair is known without
   * recording it. Useful for read-only checks before processing.
   *
   * Performs opportunistic sweep so expired entries are not reported
   * as known.
   */
  isKnown(connectionId: string, nonce: string, now?: number): boolean {
    const currentTime = now ?? Date.now();

    if (
      currentTime - this.lastSweep >= this.ttlMs ||
      this.seen.size >= MAX_DEDUP_ENTRIES
    ) {
      this.sweep(currentTime);
      this.evictOldestIfOverCapacity();
    }

    return this.seen.has(MessageDedupStore.key(connectionId, nonce));
  }

  /**
   * Explicitly record a `(connectionId, nonce)` pair. Use this when
   * dedup checking and recording are done in separate steps (e.g.,
   * record only after successful processing).
   *
   * Performs opportunistic sweep to keep the store bounded.
   */
  record(connectionId: string, nonce: string, now?: number): void {
    const currentTime = now ?? Date.now();

    if (
      currentTime - this.lastSweep >= this.ttlMs ||
      this.seen.size >= MAX_DEDUP_ENTRIES
    ) {
      this.sweep(currentTime);
      this.evictOldestIfOverCapacity();
    }

    this.seen.set(MessageDedupStore.key(connectionId, nonce), currentTime);
  }

  /**
   * Evict entries older than TTL. Returns the number of entries evicted.
   */
  sweep(now?: number): number {
    const currentTime = now ?? Date.now();
    const cutoff = currentTime - this.ttlMs;
    let evicted = 0;

    for (const [key, timestamp] of this.seen) {
      if (timestamp < cutoff) {
        this.seen.delete(key);
        evicted++;
      }
    }

    this.lastSweep = currentTime;
    return evicted;
  }

  /**
   * Hard-cap enforcement: if the store is still at or above capacity
   * after a TTL sweep (e.g., burst of unique nonces within one TTL
   * window), evict the oldest entries until under the limit.
   */
  private evictOldestIfOverCapacity(): void {
    if (this.seen.size < MAX_DEDUP_ENTRIES) return;

    const excess = this.seen.size - MAX_DEDUP_ENTRIES + 1;
    const entries = [...this.seen.entries()].sort((a, b) => a[1] - b[1]);

    for (let i = 0; i < excess && i < entries.length; i++) {
      this.seen.delete(entries[i][0]);
    }
  }

  /** Current number of tracked entries. */
  get size(): number {
    return this.seen.size;
  }

  /** Clear all entries (for testing). */
  clear(): void {
    this.seen.clear();
    this.lastSweep = 0;
  }
}

/** Default singleton for production use. */
export const defaultMessageDedupStore = new MessageDedupStore();
