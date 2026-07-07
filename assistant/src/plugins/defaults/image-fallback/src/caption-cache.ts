/**
 * Read-through cache for image captions, keyed by the sha-256 hash of the
 * image's base64 data: an in-memory LRU in front of the durable
 * `image_caption_cache` table (migration 321).
 *
 * Raw images stay in persisted history (clients render them), so every path
 * that rebuilds provider-bound context from persistence — each turn's
 * `user-prompt-submit` sweep, the mid-turn `post-compact` sweep, a daemon
 * restart — re-encounters the same images. The in-memory layer keeps
 * same-session sweeps free of even a DB hit; the table makes sweeps
 * lookup-only across restarts, so a previously captioned image is never
 * re-billed as a vision call.
 *
 * The DB layer fails open: when the database is unavailable or errors, reads
 * behave as misses and writes are dropped, degrading to in-memory-only
 * caching rather than surfacing an error into the sweep.
 */

import { createHash } from "node:crypto";

import { getDb, getSqliteFrom } from "../../../../persistence/db-connection.js";

const MAX_MEMORY_ENTRIES = 500;
const MAX_DB_ENTRIES = 2000;

const cache = new Map<string, string>();

/** sha-256 hex digest of an image's base64 payload. */
export function imageHash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

function setMemoryCaption(hash: string, caption: string): void {
  if (cache.size >= MAX_MEMORY_ENTRIES && !cache.has(hash)) {
    const oldest = cache.keys().next();
    if (!oldest.done) {
      cache.delete(oldest.value as string);
    }
  }
  cache.set(hash, caption);
}

function dbLookupCaption(hash: string): string | undefined {
  try {
    const raw = getSqliteFrom(getDb());
    const row = raw
      .query(
        /*sql*/ `SELECT caption FROM image_caption_cache WHERE image_hash = ?`,
      )
      .get(hash) as { caption: string } | null;
    if (row == null) {
      return undefined;
    }
    raw
      .query(
        /*sql*/ `UPDATE image_caption_cache SET last_used_at = ? WHERE image_hash = ?`,
      )
      .run(Date.now(), hash);
    return row.caption;
  } catch {
    // Fail open: an unavailable DB behaves as a miss.
    return undefined;
  }
}

function dbStoreCaption(hash: string, caption: string): void {
  try {
    const raw = getSqliteFrom(getDb());
    const now = Date.now();
    raw
      .query(
        /*sql*/ `
        INSERT INTO image_caption_cache (image_hash, caption, created_at, last_used_at)
        VALUES (?, ?, ?, ?)
        ON CONFLICT(image_hash) DO UPDATE SET
          caption = excluded.caption,
          last_used_at = excluded.last_used_at
      `,
      )
      .run(hash, caption, now, now);
    // Bound the table by evicting the least-recently-used rows beyond the cap.
    raw
      .query(
        /*sql*/ `
        DELETE FROM image_caption_cache WHERE image_hash IN (
          SELECT image_hash FROM image_caption_cache
          ORDER BY last_used_at DESC LIMIT -1 OFFSET ?
        )
      `,
      )
      .run(MAX_DB_ENTRIES);
  } catch {
    // Fail open: the caption still lives in the in-memory layer.
  }
}

/** Look up a cached caption. `undefined` = miss; a string (even empty) = hit. */
export function getCachedCaption(hash: string): string | undefined {
  const value = cache.get(hash);
  if (value !== undefined) {
    // Move to end (most-recently-used) for LRU eviction.
    cache.delete(hash);
    cache.set(hash, value);
    return value;
  }
  const persisted = dbLookupCaption(hash);
  if (persisted !== undefined) {
    setMemoryCaption(hash, persisted);
  }
  return persisted;
}

/** Store a caption in both the in-memory layer and the durable table. */
export function setCachedCaption(hash: string, caption: string): void {
  setMemoryCaption(hash, caption);
  dbStoreCaption(hash, caption);
}

/** Test-only: clear the in-memory layer and best-effort clear the table. */
export function resetCaptionCacheForTests(): void {
  cache.clear();
  try {
    getSqliteFrom(getDb()).exec(/*sql*/ `DELETE FROM image_caption_cache`);
  } catch {
    // Table absent in DB-less test environments — nothing to clear.
  }
}
