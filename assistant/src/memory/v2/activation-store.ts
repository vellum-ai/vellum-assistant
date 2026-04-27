// ---------------------------------------------------------------------------
// Memory v2 — Activation state SQLite persistence
// ---------------------------------------------------------------------------
//
// One row per conversation. The row is hydrated on resume, mutated in-memory
// across the turn, and written back at the end of the turn. Forking a
// conversation copies the parent row so the child starts with the same
// activation/everInjected snapshot.

import { eq } from "drizzle-orm";

import type { DrizzleDb } from "../db-connection.js";
import { activationState } from "../schema.js";
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
 */
export async function fork(
  database: DrizzleDb,
  parentConversationId: string,
  newConversationId: string,
): Promise<void> {
  const parent = await hydrate(database, parentConversationId);
  if (!parent) return;
  await save(database, newConversationId, parent);
}

/**
 * Drop `everInjected` entries whose `turn` is at or below `upToTurn`.
 * Used after compaction evicts older turns — slugs that lived only on those
 * turns become eligible for re-injection on the next turn.
 */
export function evictCompactedTurns(
  state: ActivationState,
  upToTurn: number,
): ActivationState {
  const everInjected: EverInjectedEntry[] = state.everInjected.filter(
    (entry) => entry.turn > upToTurn,
  );
  return { ...state, everInjected };
}
