import { eq } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { memoryCheckpoints } from "./schema/index.js";

export interface MessageCursorCheckpoint {
  createdAt: number;
  messageId: string;
}

export function getMemoryCheckpoint(key: string): string | null {
  const db = getDb();
  const row = db
    .select({ value: memoryCheckpoints.value })
    .from(memoryCheckpoints)
    .where(eq(memoryCheckpoints.key, key))
    .get();
  return row?.value ?? null;
}

export function setMemoryCheckpoint(key: string, value: string): void {
  const db = getDb();
  const now = Date.now();
  db.insert(memoryCheckpoints)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({
      target: memoryCheckpoints.key,
      set: { value, updatedAt: now },
    })
    .run();
}

export function deleteMemoryCheckpoint(key: string): void {
  const db = getDb();
  db.delete(memoryCheckpoints).where(eq(memoryCheckpoints.key, key)).run();
}

export function readMessageCursorCheckpoint(
  createdAtKey: string,
  messageIdKey: string,
): MessageCursorCheckpoint {
  const createdAt =
    Number.parseInt(getMemoryCheckpoint(createdAtKey) ?? "0", 10) || 0;
  const messageId = getMemoryCheckpoint(messageIdKey) ?? "";
  return { createdAt, messageId };
}

export function writeMessageCursorCheckpoint(
  createdAtKey: string,
  messageIdKey: string,
  checkpoint: MessageCursorCheckpoint,
): void {
  setMemoryCheckpoint(createdAtKey, String(checkpoint.createdAt));
  setMemoryCheckpoint(messageIdKey, checkpoint.messageId);
}

export function resetMessageCursorCheckpoint(
  createdAtKey: string,
  messageIdKey: string,
): void {
  writeMessageCursorCheckpoint(createdAtKey, messageIdKey, {
    createdAt: 0,
    messageId: "",
  });
}

/**
 * Completion sentinel for the messages lexical-index backfill. Set once the
 * backfill has drained the entire `messages` table into the Qdrant lexical
 * index (`messages_lexical`); cleared on a `force` re-run.
 *
 * Lives here — in `persistence/` — so it is the single source of truth for the
 * backfill handler (plugin layer, which writes it) AND the message-search read
 * sites (persistence + plugin layers, which gate the read backend on it).
 * Keeping the key and its reader here lets `conversation-queries.ts` (also
 * `persistence/`) read it without a persistence -> plugin import.
 */
export const LEXICAL_BACKFILL_COMPLETE_KEY =
  "lexical:messages:backfill_complete";

/**
 * True once the messages lexical-index backfill has fully drained on this
 * instance.
 *
 * Gates two things: the one-time startup auto-enqueue (skip when already
 * complete) and — critically — the message-search read backend. An upgraded
 * instance whose backfill has not finished must keep reading from SQLite FTS,
 * because a `qdrant`-backed read against the still-filling `messages_lexical`
 * collection returns an empty result (not a throw), so the Qdrant-error degrade
 * path never fires and content search would silently return nothing. Switch
 * reads to Qdrant only once this marker confirms the index is fully populated.
 */
export function isLexicalBackfillComplete(): boolean {
  return getMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY) === "1";
}

/**
 * Clear the lexical-backfill completion sentinel so {@link
 * isLexicalBackfillComplete} reads false until a run re-marks it.
 *
 * Called when a `force` re-index is requested — both at enqueue time (so reads
 * fall back to SQLite FTS the instant the rebuild is queued, rather than serving
 * from a stale/emptying `messages_lexical` collection in the window before the
 * worker claims the job) and again inside the backfill handler (idempotent).
 * Co-located with the key and its reader here so callers clear it without
 * re-declaring the key string.
 */
export function clearLexicalBackfillComplete(): void {
  deleteMemoryCheckpoint(LEXICAL_BACKFILL_COMPLETE_KEY);
}
