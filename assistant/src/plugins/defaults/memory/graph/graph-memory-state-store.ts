import { eq } from "drizzle-orm";

import { conversationGraphMemoryState } from "../../../../persistence/schema/conversations.js";
import { memoryDbOrNull } from "../memory-db.js";

/**
 * Persist graph memory state for a conversation (upsert). Writes the dedicated
 * memory connection; an unavailable memory database no-ops.
 */
export function saveGraphMemoryState(
  conversationId: string,
  stateJson: string,
): void {
  const mdb = memoryDbOrNull("saveGraphMemoryState");
  if (!mdb) return;
  const now = Date.now();
  mdb
    .insert(conversationGraphMemoryState)
    .values({ conversationId, stateJson, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: conversationGraphMemoryState.conversationId,
      set: { stateJson, updatedAt: now },
    })
    .run();
}

/**
 * Load graph memory state for a conversation, or null if none exists. Reads the
 * dedicated memory connection; an unavailable memory database reports none.
 */
export function loadGraphMemoryState(conversationId: string): string | null {
  const mdb = memoryDbOrNull("loadGraphMemoryState");
  if (!mdb) return null;
  const row = mdb
    .select({ stateJson: conversationGraphMemoryState.stateJson })
    .from(conversationGraphMemoryState)
    .where(eq(conversationGraphMemoryState.conversationId, conversationId))
    .get();
  return row?.stateJson ?? null;
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
