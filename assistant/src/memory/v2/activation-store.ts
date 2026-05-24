// ---------------------------------------------------------------------------
// Memory v2 — Activation state SQLite persistence
// ---------------------------------------------------------------------------
//
// One row per conversation. The row is hydrated on resume, mutated in-memory
// across the turn, and written back at the end of the turn. Forking a
// conversation copies the parent row so the child starts with the same
// activation snapshot.

import { eq } from "drizzle-orm";

import type { DrizzleDb } from "../db-connection.js";
import { activationState } from "../schema.js";
import { type ActivationState, ActivationStateSchema } from "./types.js";

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
  database
    .insert(activationState)
    .values({
      conversationId,
      messageId: state.messageId,
      stateJson,
      currentTurn: state.currentTurn,
      updatedAt: state.updatedAt,
    })
    .onConflictDoUpdate({
      target: activationState.conversationId,
      set: {
        messageId: state.messageId,
        stateJson,
        currentTurn: state.currentTurn,
        updatedAt: state.updatedAt,
      },
    })
    .run();
}

/**
 * Copy the parent conversation's activation row to a new conversation id.
 * No-op if the parent has no state (e.g. fork happened before any injection).
 * The child inherits the parent's activation map so its first turn starts from
 * the same retrieval state.
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
      currentTurn: row.currentTurn,
      updatedAt: row.updatedAt,
    })
    .onConflictDoUpdate({
      target: activationState.conversationId,
      set: {
        messageId: row.messageId,
        stateJson: row.stateJson,
        currentTurn: row.currentTurn,
        updatedAt: row.updatedAt,
      },
    })
    .run();
}
