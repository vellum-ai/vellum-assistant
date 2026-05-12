// ---------------------------------------------------------------------------
// Memory retrospective — per-conversation state CRUD.
// ---------------------------------------------------------------------------
//
// Two pointers move independently:
//   - `lastProcessedMessageId` advances ONLY when a retrospective run
//     completes successfully (correctness invariant — failures must
//     re-process the same messages on the next attempt).
//   - `lastRunAt` advances on EVERY job end (success or failure). Drives the
//     per-conversation cooldown gate in the trigger-check helper so failing
//     jobs can't loop in tight retries across trigger types.
//
// The schema enforces the foreign key with ON DELETE CASCADE, so deleting a
// conversation collects its state row automatically.

import { eq } from "drizzle-orm";

import { getDb } from "./db-connection.js";
import { memoryRetrospectiveState } from "./schema.js";

export interface MemoryRetrospectiveState {
  conversationId: string;
  lastProcessedMessageId: string;
  lastRunAt: number;
}

/**
 * Load the state row for a conversation, or `null` if no row exists.
 */
export function getRetrospectiveState(
  conversationId: string,
): MemoryRetrospectiveState | null {
  const row = getDb()
    .select()
    .from(memoryRetrospectiveState)
    .where(eq(memoryRetrospectiveState.conversationId, conversationId))
    .get();
  if (!row) return null;
  return {
    conversationId: row.conversationId,
    lastProcessedMessageId: row.lastProcessedMessageId,
    lastRunAt: row.lastRunAt,
  };
}

/**
 * Upsert both pointers atomically. Used on successful retrospective runs.
 */
export function upsertRetrospectiveState(args: MemoryRetrospectiveState): void {
  const db = getDb();
  db.insert(memoryRetrospectiveState)
    .values({
      conversationId: args.conversationId,
      lastProcessedMessageId: args.lastProcessedMessageId,
      lastRunAt: args.lastRunAt,
    })
    .onConflictDoUpdate({
      target: memoryRetrospectiveState.conversationId,
      set: {
        lastProcessedMessageId: args.lastProcessedMessageId,
        lastRunAt: args.lastRunAt,
      },
    })
    .run();
}

/**
 * Advance only `lastRunAt`. Used on every failure path so the cooldown gate
 * applies to subsequent trigger-driven enqueues. If no row exists yet (first
 * attempt failed), seed `lastProcessedMessageId` to the empty string — a
 * sentinel meaning "nothing successfully processed yet" that subsequent
 * `getMessagesSince(...)` queries treat the same as a missing row.
 */
export function bumpRetrospectiveLastRunAt(
  conversationId: string,
  lastRunAt: number,
): void {
  const db = getDb();
  db.insert(memoryRetrospectiveState)
    .values({
      conversationId,
      lastProcessedMessageId: "",
      lastRunAt,
    })
    .onConflictDoUpdate({
      target: memoryRetrospectiveState.conversationId,
      set: { lastRunAt },
    })
    .run();
}
