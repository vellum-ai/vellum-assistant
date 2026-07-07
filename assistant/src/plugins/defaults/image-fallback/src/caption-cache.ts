/**
 * Read-through cache for image captions, keyed by the sha-256 hash of the
 * image's base64 data: an in-memory LRU in front of a plugin-owned SQLite
 * file (`caption-cache.sqlite` in the plugin's storage dir, opened by the
 * `init` hook via {@link initCaptionStore}).
 *
 * Raw images stay in persisted history (clients render them), so every path
 * that rebuilds provider-bound context from persistence — each turn's
 * `user-prompt-submit` sweep, the mid-turn `post-compact` sweep, a daemon
 * restart — re-encounters the same images. The in-memory layer keeps
 * same-session sweeps free of even a DB hit; the durable layer makes sweeps
 * lookup-only across restarts, so a previously captioned image is never
 * re-billed as a vision call.
 *
 * Rows are keyed `(image_hash, conversation_id)` while lookups match on the
 * hash alone: the same image pasted in two conversations shares one caption
 * (and one vision call), but each conversation that touched a hash holds its
 * own row, so `conversation-deleted` cleanup ({@link
 * deleteConversationCaptions}) removes exactly that conversation's derived
 * data — a caption disappears entirely only when no surviving conversation
 * references its image.
 *
 * The durable layer fails open: before `init` runs, or when SQLite errors,
 * reads behave as misses and writes are dropped, degrading to
 * in-memory-only caching rather than surfacing an error into the sweep.
 */

import { createHash } from "node:crypto";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const MAX_MEMORY_ENTRIES = 500;
const MAX_DB_ROWS = 2000;
const MAX_DELETED_TOMBSTONES = 500;

/** In-memory LRU, keyed by image hash (conversation-agnostic). */
const cache = new Map<string, string>();

/** Plugin-owned SQLite handle; `null` until `init` opens it (fail-open). */
let db: Database | null = null;

/**
 * Recently deleted conversations, so a caption write racing its own
 * conversation's deletion (a vision call still in flight when the
 * `conversation-deleted` hook runs) is dropped instead of re-creating rows
 * for a dead conversation. In-memory is sufficient: the race is
 * within-process — an in-flight caption call cannot survive a restart.
 * Bounded FIFO (insertion order) to keep the set from growing with
 * long-lived daemons.
 */
const deletedConversations = new Set<string>();

function tombstoneConversation(conversationId: string): void {
  if (
    deletedConversations.size >= MAX_DELETED_TOMBSTONES &&
    !deletedConversations.has(conversationId)
  ) {
    const oldest = deletedConversations.values().next();
    if (!oldest.done) {
      deletedConversations.delete(oldest.value as string);
    }
  }
  deletedConversations.add(conversationId);
}

/** sha-256 hex digest of an image's base64 payload. */
export function imageHash(data: string): string {
  return createHash("sha256").update(data).digest("hex");
}

/**
 * Open (or create) the plugin's caption database inside its storage dir and
 * ensure the schema exists. Called by the plugin's `init` hook. Idempotent —
 * re-running against an existing file is a no-op — and fail-open: on error
 * the store stays memory-only.
 */
export function initCaptionStore(storageDir: string): void {
  try {
    closeCaptionStore();
    const handle = new Database(join(storageDir, "caption-cache.sqlite"));
    handle.exec("PRAGMA journal_mode=WAL");
    handle.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS image_captions (
        image_hash      TEXT NOT NULL,
        conversation_id TEXT NOT NULL,
        caption         TEXT NOT NULL,
        created_at      INTEGER NOT NULL,
        last_used_at    INTEGER NOT NULL,
        PRIMARY KEY (image_hash, conversation_id)
      )
    `);
    handle.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_image_captions_last_used ON image_captions(last_used_at)`,
    );
    handle.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_image_captions_conversation ON image_captions(conversation_id)`,
    );
    db = handle;
  } catch {
    db = null;
  }
}

/** Close the caption database. Called by the plugin's `shutdown` hook. */
export function closeCaptionStore(): void {
  try {
    db?.close();
  } catch {
    // Already closed or unusable — either way the handle is discarded.
  }
  db = null;
}

/**
 * Record that `conversationId` uses `hash`, refreshing recency and the
 * caption text, and evict the least-recently-used rows beyond the cap.
 */
function dbRecordUse(
  hash: string,
  conversationId: string,
  caption: string,
): void {
  if (db == null || deletedConversations.has(conversationId)) {
    return;
  }
  try {
    const now = Date.now();
    db.query(
      /*sql*/ `
      INSERT INTO image_captions (image_hash, conversation_id, caption, created_at, last_used_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(image_hash, conversation_id) DO UPDATE SET
        caption = excluded.caption,
        last_used_at = excluded.last_used_at
    `,
    ).run(hash, conversationId, caption, now, now);
    db.query(
      /*sql*/ `
      DELETE FROM image_captions WHERE (image_hash, conversation_id) IN (
        SELECT image_hash, conversation_id FROM image_captions
        ORDER BY last_used_at DESC LIMIT -1 OFFSET ?
      )
    `,
    ).run(MAX_DB_ROWS);
  } catch {
    // Fail open: the caption still lives in the in-memory layer.
  }
}

function dbLookupCaption(hash: string): string | undefined {
  if (db == null) {
    return undefined;
  }
  try {
    const row = db
      .query(
        /*sql*/ `SELECT caption FROM image_captions WHERE image_hash = ? LIMIT 1`,
      )
      .get(hash) as { caption: string } | null;
    return row?.caption;
  } catch {
    // Fail open: an unavailable DB behaves as a miss.
    return undefined;
  }
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

/**
 * Look up a cached caption for an image used by `conversationId`.
 * `undefined` = miss; a string (even empty) = hit. A hit from either layer
 * also records the (hash, conversation) association so `conversation-deleted`
 * cleanup stays accurate.
 */
export function getCachedCaption(
  hash: string,
  conversationId: string,
): string | undefined {
  const value = cache.get(hash);
  if (value !== undefined) {
    // Move to end (most-recently-used) for LRU eviction.
    cache.delete(hash);
    cache.set(hash, value);
    dbRecordUse(hash, conversationId, value);
    return value;
  }
  const persisted = dbLookupCaption(hash);
  if (persisted !== undefined) {
    setMemoryCaption(hash, persisted);
    dbRecordUse(hash, conversationId, persisted);
  }
  return persisted;
}

/**
 * Store a caption in both the in-memory layer and the durable table. Dropped
 * entirely when the conversation was already deleted — a vision call that
 * lost the race against its conversation's deletion must not re-introduce
 * derived caption text for it.
 */
export function setCachedCaption(
  hash: string,
  conversationId: string,
  caption: string,
): void {
  if (deletedConversations.has(conversationId)) {
    return;
  }
  setMemoryCaption(hash, caption);
  dbRecordUse(hash, conversationId, caption);
}

/**
 * Remove a deleted conversation's caption rows. Hashes no other conversation
 * references are also dropped from the in-memory layer, so the derived
 * caption text does not outlive the last conversation that contained the
 * image.
 */
export function deleteConversationCaptions(conversationId: string): number {
  // Tombstone first, before any early return: an in-flight vision call for
  // this conversation must find the tombstone when it tries to persist.
  tombstoneConversation(conversationId);
  if (db == null) {
    return 0;
  }
  try {
    const rows = db
      .query(
        /*sql*/ `SELECT image_hash FROM image_captions WHERE conversation_id = ?`,
      )
      .all(conversationId) as Array<{ image_hash: string }>;
    if (rows.length === 0) {
      return 0;
    }
    db.query(
      /*sql*/ `DELETE FROM image_captions WHERE conversation_id = ?`,
    ).run(conversationId);
    for (const { image_hash } of rows) {
      const remaining = db
        .query(
          /*sql*/ `SELECT 1 FROM image_captions WHERE image_hash = ? LIMIT 1`,
        )
        .get(image_hash);
      if (remaining == null) {
        cache.delete(image_hash);
      }
    }
    return rows.length;
  } catch {
    // Fail open: cleanup is best-effort; rows age out via LRU eviction.
    return 0;
  }
}

/** Test-only: clear the in-memory layers and best-effort clear the table. */
export function resetCaptionCacheForTests(): void {
  cache.clear();
  deletedConversations.clear();
  try {
    db?.exec(/*sql*/ `DELETE FROM image_captions`);
  } catch {
    // Store not initialized in DB-less test environments — nothing to clear.
  }
}
