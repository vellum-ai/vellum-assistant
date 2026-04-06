import { eq } from "drizzle-orm";

import { getDb } from "../db.js";
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
export function loadGraphMemoryState(
  conversationId: string,
): string | null {
  const db = getDb();
  const row = db
    .select({ stateJson: conversationGraphMemoryState.stateJson })
    .from(conversationGraphMemoryState)
    .where(eq(conversationGraphMemoryState.conversationId, conversationId))
    .get();
  return row?.stateJson ?? null;
}
