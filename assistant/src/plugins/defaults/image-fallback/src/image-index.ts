/**
 * Index of the images a conversation has shown, so the `image_ask` tool can
 * turn a filename the model read in a caption back into bytes on disk.
 *
 * The caption sweep visits every image in the provider-bound history on every
 * text-only turn, so writing a row there keeps the index complete for exactly
 * the conversations where the tool is active, with no separate history scan.
 * A row is the image's on-disk location plus the media type and content hash;
 * the bytes themselves stay where the host already keeps them (the attachment
 * store for user uploads, the plugin's content-hash-deduped copy for inline
 * base64).
 *
 * The table lives in the plugin's own SQLite file next to the caption cache
 * (`caption-cache.sqlite`, opened by `init`), never in the main database.
 * `conversation-deleted` purges a conversation's rows and `shutdown` closes
 * the handle. Every operation fails open: an unavailable store makes the
 * index look empty rather than faulting the sweep or the tool.
 */

import { basename } from "node:path";

import { getPluginDatabase } from "./caption-cache.js";

/** Cap on indexed rows, evicting the oldest first. */
const MAX_INDEX_ROWS = 5000;

/** One indexed image. */
export interface ConversationImage {
  conversationId: string;
  filePath: string;
  mediaType: string;
  imageHash: string;
  addedAt: number;
}

interface ImageRow {
  conversation_id: string;
  file_path: string;
  media_type: string;
  image_hash: string;
  added_at: number;
}

function toConversationImage(row: ImageRow): ConversationImage {
  return {
    conversationId: row.conversation_id,
    filePath: row.file_path,
    mediaType: row.media_type,
    imageHash: row.image_hash,
    addedAt: row.added_at,
  };
}

/**
 * Create the index table in the plugin's database. Called by the plugin's
 * `init` hook once `initCaptionStore` has opened the handle. Idempotent and
 * fail-open: without the table every read is empty and every write is dropped.
 */
export function initImageIndex(): void {
  const db = getPluginDatabase();
  if (db == null) {
    return;
  }
  try {
    db.exec(/*sql*/ `
      CREATE TABLE IF NOT EXISTS conversation_images (
        conversation_id TEXT NOT NULL,
        file_path       TEXT NOT NULL,
        media_type      TEXT NOT NULL,
        image_hash      TEXT NOT NULL,
        added_at        INTEGER NOT NULL,
        PRIMARY KEY (conversation_id, file_path)
      )
    `);
    db.exec(
      /*sql*/ `CREATE INDEX IF NOT EXISTS idx_conversation_images_conversation ON conversation_images(conversation_id, added_at)`,
    );
  } catch {
    // Fail open: the tool reports no known images instead of erroring.
  }
}

/**
 * Record that `conversationId` shows the image stored at `filePath`.
 *
 * `added_at` is the first-seen time and is left alone on re-record, so the
 * newest row stays the image most recently added to the conversation even
 * though the sweep re-visits every older image each turn.
 */
export function recordConversationImage(
  conversationId: string,
  filePath: string,
  mediaType: string,
  hash: string,
): void {
  const db = getPluginDatabase();
  if (db == null || conversationId === "" || filePath === "") {
    return;
  }
  try {
    db.query(
      /*sql*/ `
      INSERT INTO conversation_images (conversation_id, file_path, media_type, image_hash, added_at)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(conversation_id, file_path) DO UPDATE SET
        media_type = excluded.media_type,
        image_hash = excluded.image_hash
    `,
    ).run(conversationId, filePath, mediaType, hash, Date.now());
    db.query(
      /*sql*/ `
      DELETE FROM conversation_images WHERE (conversation_id, file_path) IN (
        SELECT conversation_id, file_path FROM conversation_images
        ORDER BY added_at DESC, rowid DESC LIMIT -1 OFFSET ?
      )
    `,
    ).run(MAX_INDEX_ROWS);
  } catch {
    // Fail open: an unindexed image is one the tool cannot resolve by name.
  }
}

/**
 * A conversation's indexed images, newest first. `rowid` breaks ties so
 * images indexed within the same millisecond keep the order the sweep saw
 * them in.
 */
export function listConversationImages(
  conversationId: string,
): ConversationImage[] {
  const db = getPluginDatabase();
  if (db == null) {
    return [];
  }
  try {
    const rows = db
      .query(
        /*sql*/ `
        SELECT conversation_id, file_path, media_type, image_hash, added_at
        FROM conversation_images
        WHERE conversation_id = ?
        ORDER BY added_at DESC, rowid DESC
      `,
      )
      .all(conversationId) as ImageRow[];
    return rows.map(toConversationImage);
  } catch {
    // Fail open: behave as a conversation with no indexed images.
    return [];
  }
}

/**
 * Pick the image a tool call names out of `images` (newest first).
 *
 * `ref` is whatever the model wrote: the stored path from the transcript, the
 * bare filename the caption showed, or nothing at all. Resolution is exact
 * path, then exact basename, then (with no `ref`) the newest image. Returns
 * `null` when a named image is not in the list, so the caller can answer with
 * the names that are.
 */
export function resolveConversationImage(
  images: ConversationImage[],
  ref?: string,
): ConversationImage | null {
  if (images.length === 0) {
    return null;
  }
  const wanted = ref?.trim() ?? "";
  if (wanted === "") {
    return images[0];
  }
  const byPath = images.find((image) => image.filePath === wanted);
  if (byPath != null) {
    return byPath;
  }
  const wantedName = basename(wanted);
  const byName = images.find(
    (image) => basename(image.filePath) === wantedName,
  );
  return byName ?? null;
}

/**
 * Remove a deleted conversation's index rows. Returns how many were removed.
 */
export function deleteConversationImages(conversationId: string): number {
  const db = getPluginDatabase();
  if (db == null) {
    return 0;
  }
  try {
    const result = db
      .query(
        /*sql*/ `DELETE FROM conversation_images WHERE conversation_id = ?`,
      )
      .run(conversationId);
    return Number(result.changes ?? 0);
  } catch {
    // Fail open: cleanup is best-effort; rows age out via the row cap.
    return 0;
  }
}

/** Test-only: drop every indexed row. */
export function resetImageIndexForTests(): void {
  const db = getPluginDatabase();
  try {
    db?.exec(/*sql*/ `DELETE FROM conversation_images`);
  } catch {
    // Store not initialized in DB-less test environments — nothing to clear.
  }
}
