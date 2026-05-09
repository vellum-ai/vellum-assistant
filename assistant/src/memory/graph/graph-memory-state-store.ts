import { eq } from "drizzle-orm";

import { getDb } from "../db-connection.js";
import { conversationGraphMemoryState } from "../schema.js";

/**
 * Persist graph memory state for a conversation (upsert).
 */
export function saveGraphMemoryState(
  conversationId: string,
  stateJson: string,
): void {
  const db = getDb();
  const now = Date.now();
  db.insert(conversationGraphMemoryState)
    .values({ conversationId, stateJson, createdAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: conversationGraphMemoryState.conversationId,
      set: { stateJson, updatedAt: now },
    })
    .run();
}

/**
 * Load graph memory state for a conversation, or null if none exists.
 */
export function loadGraphMemoryState(conversationId: string): string | null {
  const db = getDb();
  const row = db
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
