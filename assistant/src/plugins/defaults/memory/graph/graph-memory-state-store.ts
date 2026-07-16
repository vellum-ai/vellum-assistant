import { memorySqliteOrNull } from "../memory-db.js";

/**
 * Persist graph memory state for a conversation (upsert). Writes the dedicated
 * memory connection; an unavailable memory database no-ops.
 */
export function saveGraphMemoryState(
  conversationId: string,
  stateJson: string,
): void {
  const raw = memorySqliteOrNull("saveGraphMemoryState");
  if (!raw) return;
  const now = Date.now();
  raw
    .query(
      /*sql*/ `INSERT INTO conversation_graph_memory_state
         (conversation_id, state_json, created_at, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_id) DO UPDATE SET
         state_json = excluded.state_json,
         updated_at = excluded.updated_at`,
    )
    .run(conversationId, stateJson, now, now);
}

/**
 * Load graph memory state for a conversation, or null if none exists. Reads the
 * dedicated memory connection; an unavailable memory database reports none.
 */
export function loadGraphMemoryState(conversationId: string): string | null {
  const raw = memorySqliteOrNull("loadGraphMemoryState");
  if (!raw) return null;
  const row = raw
    .query(
      /*sql*/ `SELECT state_json FROM conversation_graph_memory_state
         WHERE conversation_id = ?`,
    )
    .get(conversationId) as { state_json: string } | null;
  return row?.state_json ?? null;
}

/**
 * Copy the parent conversation's graph memory state row to a new conversation
 * id so the forked conversation resumes with the parent's InContextTracker
 * snapshot (in-context node IDs, per-node turn log, current turn). No-op if
 * the parent has no row yet.
 */
export function forkGraphMemoryState(
  parentConversationId: string,
  newConversationId: string,
): void {
  const stateJson = loadGraphMemoryState(parentConversationId);
  if (stateJson == null) return;
  saveGraphMemoryState(newConversationId, stateJson);
}
