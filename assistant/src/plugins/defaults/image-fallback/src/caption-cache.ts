/**
 * In-memory LRU cache for image captions, keyed by the sha-256 hash of the
 * image's base64 data.
 *
 * The cache survives across turns within a session, which is the primary
 * correctness concern: without it, the same image would be re-captioned
 * (and re-billed) on every turn because `user-prompt-submit` rebuilds
 * `latestMessages` from the stored conversation each time. Re-captioning
 * on a daemon restart is acceptable — captions are cheap and the image
 * is still in the history.
 */

import { createHash } from "node:crypto";

const MAX_ENTRIES = 500;

const cache = new Map<string, string>();

/** sha-256 hex digest of an image's base64 payload. */
export function imageHash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/** Look up a cached caption. `undefined` = miss; a string (even empty) = hit. */
export function getCachedCaption(hash: string): string | undefined {
  const value = cache.get(hash);
  if (value !== undefined) {
    // Move to end (most-recently-used) for LRU eviction.
    cache.delete(hash);
    cache.set(hash, value);
  }
  return value;
}

/** Store a caption, evicting the least-recently-used entry if at capacity. */
export function setCachedCaption(hash: string, caption: string): void {
  if (cache.size >= MAX_ENTRIES) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value as string);
    }
  }
  cache.set(hash, caption);
}

/** Test-only: clear the cache. */
export function resetCaptionCacheForTests(): void {
  cache.clear();
}
