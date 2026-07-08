/**
 * In-flight conversation turns, read from the daemon's SQLite database.
 *
 * The daemon persists `conversations.processing_started_at` at every turn
 * boundary (see `Conversation.setProcessing`) precisely so out-of-process
 * callers can detect mid-turn state by reading the row directly. The monitor
 * folds that into each sample, so a memory spike in the ring buffer names the
 * conversation that was running — the live flag is nulled when the turn ends,
 * so only a sampling-time capture preserves the correlation for post-mortems.
 *
 * The read is a read-only connection (WAL allows concurrent readers, and the
 * daemon being frozen mid-turn does not block it). Best-effort: any failure —
 * database or table not created yet, lock contention — yields null.
 */

import { Database } from "bun:sqlite";

import { getDbPath } from "../util/platform.js";

/** Cap on entries recorded per sample so a pathological burst stays bounded. */
const MAX_ENTRIES = 20;
/** Cap on recorded title length; titles can carry long user content. */
const MAX_TITLE_CHARS = 80;

export interface ActiveConversation {
  conversationId: string;
  /** Truncated conversation title — names background jobs at a glance. */
  title: string | null;
  originChannel: string | null;
  originInterface: string | null;
  processingStartedAt: number;
}

let db: Database | null = null;

function getDb(): Database | null {
  if (db != null) {
    return db;
  }
  try {
    db = new Database(getDbPath(), { readonly: true });
  } catch {
    // Database not created yet — retried on the next read.
    db = null;
  }
  return db;
}

/**
 * Conversations currently mid-turn, longest-running first. Null when the
 * database is unavailable or nothing is processing.
 */
export function readActiveConversations(): ActiveConversation[] | null {
  const handle = getDb();
  if (handle == null) {
    return null;
  }
  try {
    const rows = handle
      .query(
        `SELECT id, title, origin_channel AS originChannel,
                origin_interface AS originInterface,
                processing_started_at AS processingStartedAt
         FROM conversations
         WHERE processing_started_at IS NOT NULL
         ORDER BY processing_started_at ASC
         LIMIT ?`,
      )
      .all(MAX_ENTRIES) as Array<{
      id: string;
      title: string | null;
      originChannel: string | null;
      originInterface: string | null;
      processingStartedAt: number;
    }>;
    if (rows.length === 0) {
      return null;
    }
    return rows.map((row) => ({
      conversationId: row.id,
      title: row.title != null ? row.title.slice(0, MAX_TITLE_CHARS) : null,
      originChannel: row.originChannel,
      originInterface: row.originInterface,
      processingStartedAt: row.processingStartedAt,
    }));
  } catch {
    // Schema not migrated yet, or the handle went stale — drop it and retry
    // with a fresh connection on the next read.
    try {
      handle.close();
    } catch {
      // best-effort
    }
    db = null;
    return null;
  }
}
