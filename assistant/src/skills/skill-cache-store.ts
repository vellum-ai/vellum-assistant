import { randomBytes } from "crypto";

/** Default time-to-live for cache entries: 30 minutes. */
const DEFAULT_TTL_MS = 30 * 60_000;

/** Default maximum number of entries before LRU eviction kicks in. */
const DEFAULT_MAX_ENTRIES = 64;

interface CacheEntry {
  data: unknown;
  expiresAt: number;
}

/**
 * Daemon-process singleton in-memory cache with TTL and LRU eviction.
 *
 * - Keys are auto-generated 16-char hex strings unless an explicit key is provided.
 * - TTL defaults to 30 minutes; per-entry override via `ttlMs`.
 * - Uses Map insertion order for LRU; `get` refreshes position.
 * - At capacity, the oldest entry is evicted before a new insert.
 * - Expired entries are lazily evicted on `get`.
 */
const _store = new Map<string, CacheEntry>();

/**
 * Store a value in the cache.
 *
 * If `options.key` is provided, the entry is upserted at that key
 * (refreshing insertion order and resetting expiry).
 * Otherwise a random 16-char hex key is generated.
 */
export function setCacheEntry(
  data: unknown,
  options?: { key?: string; ttlMs?: number },
): { key: string } {
  const key = options?.key ?? randomBytes(8).toString("hex");
  const ttl = options?.ttlMs ?? DEFAULT_TTL_MS;

  // Upsert: delete first so the re-insert moves to the end of the Map
  // (refreshes LRU position).
  if (_store.has(key)) {
    _store.delete(key);
  }

  // LRU eviction: if at capacity after removing a potential existing key,
  // drop the oldest entry (first key in Map iteration order).
  if (_store.size >= DEFAULT_MAX_ENTRIES) {
    const oldest = _store.keys().next().value;
    if (oldest !== undefined) _store.delete(oldest);
  }

  _store.set(key, { data, expiresAt: Date.now() + ttl });
  return { key };
}

/**
 * Retrieve a value from the cache.
 *
 * Returns `null` if the key does not exist or the entry has expired.
 * On a hit, the entry is moved to the end of the Map (LRU refresh).
 */
export function getCacheEntry(key: string): { data: unknown } | null {
  const entry = _store.get(key);
  if (!entry) return null;

  // Lazy TTL eviction.
  if (Date.now() >= entry.expiresAt) {
    _store.delete(key);
    return null;
  }

  // LRU refresh: delete + re-set moves the entry to the tail.
  _store.delete(key);
  _store.set(key, entry);

  return { data: entry.data };
}

/**
 * Remove a cache entry by key. Returns `true` if an entry was deleted,
 * `false` if the key was not present (idempotent).
 */
export function deleteCacheEntry(key: string): boolean {
  return _store.delete(key);
}

/** Clear all entries — exposed for test isolation only. */
export function clearCacheForTests(): void {
  _store.clear();
}

/** Visible-for-testing internals. */
export const _internals = {
  store: _store,
  DEFAULT_TTL_MS,
  DEFAULT_MAX_ENTRIES,
};
