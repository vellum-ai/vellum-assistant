// ---------------------------------------------------------------------------
// Memory v2 — Activation state SQLite persistence
// ---------------------------------------------------------------------------
//
// One row per conversation. The row is hydrated on resume, mutated in-memory
// across the turn, and written back at the end of the turn. Forking a
// conversation copies the parent row so the child starts with the same
// activation/everInjected snapshot.

import { eq } from "drizzle-orm";

import type { DrizzleDb } from "../../../../persistence/db-connection.js";
import { activationState } from "../../../../persistence/schema/index.js";
import {
  type ActivationState,
  ActivationStateSchema,
  type EverInjectedEntry,
} from "./types.js";

/**
 * Load the activation state for a conversation, or `null` if no row exists.
 * Validates the on-disk JSON columns through `ActivationStateSchema`.
 */
export async function hydrate(
  database: DrizzleDb,
  conversationId: string,
): Promise<ActivationState | null> {
  const row = database
    .select()
    .from(activationState)
    .where(eq(activationState.conversationId, conversationId))
    .get();
  if (!row) return null;

  return ActivationStateSchema.parse({
    messageId: row.messageId,
    state: JSON.parse(row.stateJson),
    everInjected: JSON.parse(row.everInjectedJson),
    currentTurn: row.currentTurn,
    updatedAt: row.updatedAt,
  });
}

/**
 * Upsert the activation state for a conversation. The `updatedAt` field of
 * `state` is persisted as-is — callers control the timestamp.
 */
export async function save(
  database: DrizzleDb,
  conversationId: string,
  state: ActivationState,
): Promise<void> {
  const stateJson = JSON.stringify(state.state);
  const everInjectedJson = JSON.stringify(state.everInjected);
  database
    .insert(activationState)
    .values({
      conversationId,
      messageId: state.messageId,
      stateJson,
      everInjectedJson,
      currentTurn: state.currentTurn,
      updatedAt: state.updatedAt,
    })
    .onConflictDoUpdate({
      target: activationState.conversationId,
      set: {
        messageId: state.messageId,
        stateJson,
        everInjectedJson,
        currentTurn: state.currentTurn,
        updatedAt: state.updatedAt,
      },
    })
    .run();
}

/**
 * Copy the parent conversation's activation row to a new conversation id.
 * No-op if the parent has no state (e.g. fork happened before any injection).
 *
 * The child row inherits everInjected as-is so previously-attached slugs are
 * not re-injected on the child's first turn — matching the v1 semantics where
 * a fork carries over all in-context memories.
 *
 * Synchronous so it can run inside the bun:sqlite transaction that wraps
 * `forkConversation()` — keeping the state copy atomic with the message and
 * attachment copies.
 */
export function forkActivationState(
  database: DrizzleDb,
  parentConversationId: string,
  newConversationId: string,
): void {
  const row = database
    .select()
    .from(activationState)
    .where(eq(activationState.conversationId, parentConversationId))
    .get();
  if (!row) return;

  database
    .insert(activationState)
    .values({
      conversationId: newConversationId,
      messageId: row.messageId,
      stateJson: row.stateJson,
      everInjectedJson: row.everInjectedJson,
      currentTurn: row.currentTurn,
      updatedAt: row.updatedAt,
    })
    .onConflictDoUpdate({
      target: activationState.conversationId,
      set: {
        messageId: row.messageId,
        stateJson: row.stateJson,
        everInjectedJson: row.everInjectedJson,
        currentTurn: row.currentTurn,
        updatedAt: row.updatedAt,
      },
    })
    .run();
}

/**
 * Seed a truncated fork's activation row from the concept slugs whose
 * `<memory>` attachments the child actually inherited.
 *
 * Truncated forks cannot take the wholesale `forkActivationState` copy: the
 * parent row marks slugs injected on turns the child does not contain, so
 * copying it would suppress those pages in the child forever (silent recall
 * holes). Seeding nothing has the opposite failure — every attachment already
 * present in the copied history gets re-selected and re-attached on the
 * child's next turns as a duplicate. Deriving `everInjected` from the
 * inherited attachments themselves is exact by construction.
 *
 * Activation scores and the turn counter intentionally start fresh: the turn
 * counter is supplied by the graph tracker, which is also not copied for
 * truncated forks, so both counters restart together. Inherited entries are
 * stamped `turn: 0` — dedup is slug-set membership (`turn` is bookkeeping
 * only) and compaction clears the list wholesale.
 *
 * No-op when the child inherited no memory attachments. Synchronous so it can
 * run inside the transaction that wraps `forkConversation()`.
 */
export function seedForkActivationState(
  database: DrizzleDb,
  newConversationId: string,
  inheritedSlugs: string[],
): void {
  if (inheritedSlugs.length === 0) return;

  const everInjected: EverInjectedEntry[] = inheritedSlugs.map((slug) => ({
    slug,
    turn: 0,
  }));
  database
    .insert(activationState)
    .values({
      conversationId: newConversationId,
      messageId: `${newConversationId}:turn:0`,
      stateJson: "{}",
      everInjectedJson: JSON.stringify(everInjected),
      currentTurn: 0,
      updatedAt: Date.now(),
    })
    .run();
}

/**
 * Clear all `everInjected` entries. Used after compaction: the cached
 * `<memory>` attachments those slugs lived on are gone, so future turns
 * should be free to re-inject them.
 *
 * Unconditionally empties the list rather than filtering by turn number.
 * `everInjected` is persisted on every turn while the in-memory tracker's
 * `currentTurn` is only snapshotted on graceful conversation dispose, so a
 * non-graceful shutdown (SIGKILL, crash) followed by a reload can leave
 * `everInjected` entries with `turn` values above the restored tracker's
 * `currentTurn`. A turn-bounded filter misses those stale entries and they
 * dedupe forever; a full clear is robust to that drift.
 */
export function clearEverInjected(state: ActivationState): ActivationState {
  return { ...state, everInjected: [] };
}
