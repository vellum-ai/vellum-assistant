import { createHash } from 'crypto';
import type { MemoryRecallResult, MemoryRecallOptions } from './search/types.js';

/**
 * In-memory cache for memory recall results.
 *
 * The full retrieval pipeline (FTS5 + Qdrant + entity graph + RRF merge) is
 * expensive. When the same query is issued multiple turns in a row (common
 * when the conversation context hasn't changed), we can serve the cached
 * result instantly.
 *
 * Invalidation: a monotonic version counter is bumped whenever new memory
 * is indexed (segments, items, embeddings). Cache entries are only valid
 * when their version matches the current global version.
 */

interface CacheEntry {
  version: number;
  createdAt: number;
  result: MemoryRecallResult;
}

const MAX_ENTRIES = 32;
const TTL_MS = 60_000; // 60 seconds

let _version = 0;
const _cache = new Map<string, CacheEntry>();

/** Bump the global memory version, invalidating all cached recall results. */
export function bumpMemoryVersion(): void {
  _version++;
}

/** Return the current memory version (for snapshot-based staleness checks). */
export function getMemoryVersion(): number {
  return _version;
}

/** Build a deterministic cache key from the recall inputs. */
function buildCacheKey(
  query: string,
  conversationId: string,
  options?: MemoryRecallOptions,
): string {
  const parts = [
    query,
    conversationId,
    options?.scopeId ?? '',
    options?.scopePolicyOverride
      ? `${options.scopePolicyOverride.scopeId}:${options.scopePolicyOverride.fallbackToDefault}`
      : '',
    options?.excludeMessageIds ? [...options.excludeMessageIds].sort().join(',') : '',
    options?.maxInjectTokensOverride != null ? String(options.maxInjectTokensOverride) : '',
  ];
  return createHash('sha256').update(parts.join('\0')).digest('hex');
}

/** Look up a cached recall result. Returns undefined on miss or stale entry. */
export function getCachedRecall(
  query: string,
  conversationId: string,
  options?: MemoryRecallOptions,
): MemoryRecallResult | undefined {
  const key = buildCacheKey(query, conversationId, options);
  const entry = _cache.get(key);
  if (!entry) return undefined;
  if (entry.version !== _version || Date.now() - entry.createdAt > TTL_MS) {
    _cache.delete(key);
    return undefined;
  }
  return entry.result;
}

/**
 * Store a recall result in the cache. Evicts oldest entries when full.
 *
 * When `snapshotVersion` is provided, the entry is only stored if the
 * snapshot still matches the current global version — this prevents a
 * stale result from being cached under a version that was bumped while
 * the retrieval pipeline was in flight.
 */
export function setCachedRecall(
  query: string,
  conversationId: string,
  options: MemoryRecallOptions | undefined,
  result: MemoryRecallResult,
  snapshotVersion?: number,
): void {
  // If a snapshot version was provided, only cache when it still matches
  // the current version — otherwise the result may be stale.
  if (snapshotVersion !== undefined && snapshotVersion !== _version) return;

  const key = buildCacheKey(query, conversationId, options);

  // Evict oldest entries if at capacity
  if (_cache.size >= MAX_ENTRIES && !_cache.has(key)) {
    const oldest = _cache.keys().next().value;
    if (oldest !== undefined) _cache.delete(oldest);
  }

  _cache.set(key, { version: _version, createdAt: Date.now(), result });
}

/** Clear the entire cache (useful for testing). */
export function clearRecallCache(): void {
  _cache.clear();
}
