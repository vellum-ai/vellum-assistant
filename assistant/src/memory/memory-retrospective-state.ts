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

import { type DrizzleDb, getDb } from "./db-connection.js";
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
 * Carry the source conversation's retrospective state into a forked child so
 * the fork doesn't re-process content the parent already covered. Synchronous
 * so it can run inside the bun:sqlite transaction wrapping `forkConversation`.
 *
 * Mapping for `lastProcessedMessageId`:
 *
 *   - source has no state row → no-op (child inherits "first run" semantics
 *     and `findMostRecentRetrospectiveFor` walks the fork chain instead).
 *   - source pointer is the `""` sentinel (failed-only attempts, never
 *     succeeded) → child pointer is also `""`.
 *   - source pointer is within the copied range (`forkedMessageIds` has it) →
 *     child pointer is the mapped forked message ID.
 *   - source pointer is past the fork boundary (not in `forkedMessageIds`) →
 *     child pointer is the last copied message's mapped ID. All copied
 *     messages have already been retro'd by the source, so the child should
 *     wait for new post-fork messages before its first retro fires.
 *
 * `lastRunAt` is copied verbatim — the cooldown gate inherits from source.
 */
export function forkRetrospectiveState(args: {
  database: DrizzleDb;
  sourceConversationId: string;
  forkedConversationId: string;
  forkedMessageIds: Map<string, string>;
  lastCopiedSourceMessageId: string | null;
}): void {
  const {
    database,
    sourceConversationId,
    forkedConversationId,
    forkedMessageIds,
    lastCopiedSourceMessageId,
  } = args;

  const sourceRow = database
    .select()
    .from(memoryRetrospectiveState)
    .where(eq(memoryRetrospectiveState.conversationId, sourceConversationId))
    .get();
  if (!sourceRow) return;

  let forkedPointer = "";
  if (sourceRow.lastProcessedMessageId !== "") {
    const mapped = forkedMessageIds.get(sourceRow.lastProcessedMessageId);
    if (mapped !== undefined) {
      forkedPointer = mapped;
    } else if (lastCopiedSourceMessageId !== null) {
      // Source pointer is past the fork boundary — everything copied has
      // already been processed by the source, so clamp to the last copied
      // message so the fork waits for new post-fork messages.
      forkedPointer = forkedMessageIds.get(lastCopiedSourceMessageId) ?? "";
    }
  }

  database
    .insert(memoryRetrospectiveState)
    .values({
      conversationId: forkedConversationId,
      lastProcessedMessageId: forkedPointer,
      lastRunAt: sourceRow.lastRunAt,
    })
    .onConflictDoUpdate({
      target: memoryRetrospectiveState.conversationId,
      set: {
        lastProcessedMessageId: forkedPointer,
        lastRunAt: sourceRow.lastRunAt,
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
