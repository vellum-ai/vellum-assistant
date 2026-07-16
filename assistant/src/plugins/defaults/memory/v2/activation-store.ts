// ---------------------------------------------------------------------------
// Memory v2 — Activation state SQLite persistence
// ---------------------------------------------------------------------------
//
// One row per conversation. The row is hydrated on resume, mutated in-memory
// across the turn, and written back at the end of the turn. Forking a
// conversation copies the parent row so the child starts with the same
// activation/everInjected snapshot.

import { memorySqliteOrNull } from "../memory-db.js";
import {
  type ActivationState,
  ActivationStateSchema,
  type EverInjectedEntry,
} from "../v3/substrate/types.js";

const UPSERT_SQL = /*sql*/ `
  INSERT INTO activation_state
    (conversation_id, message_id, state_json, ever_injected_json, current_turn, updated_at)
  VALUES (?, ?, ?, ?, ?, ?)
  ON CONFLICT(conversation_id) DO UPDATE SET
    message_id = excluded.message_id,
    state_json = excluded.state_json,
    ever_injected_json = excluded.ever_injected_json,
    current_turn = excluded.current_turn,
    updated_at = excluded.updated_at`;

interface ActivationStateRow {
  message_id: string;
  state_json: string;
  ever_injected_json: string;
  current_turn: number;
  updated_at: number;
}

/**
 * Load the activation state for a conversation, or `null` if no row exists.
 * Validates the on-disk JSON columns through `ActivationStateSchema`. Reads the
 * dedicated memory connection; an unavailable memory database reports no state.
 */
export async function hydrate(
  conversationId: string,
): Promise<ActivationState | null> {
  const raw = memorySqliteOrNull("hydrateActivationState");
  if (!raw) return null;
  const row = raw
    .query(
      /*sql*/ `SELECT message_id, state_json, ever_injected_json, current_turn, updated_at
         FROM activation_state WHERE conversation_id = ?`,
    )
    .get(conversationId) as ActivationStateRow | null;
  if (!row) return null;

  return ActivationStateSchema.parse({
    messageId: row.message_id,
    state: JSON.parse(row.state_json),
    everInjected: JSON.parse(row.ever_injected_json),
    currentTurn: row.current_turn,
    updatedAt: row.updated_at,
  });
}

/**
 * Upsert the activation state for a conversation. The `updatedAt` field of
 * `state` is persisted as-is — callers control the timestamp. Writes the
 * dedicated memory connection; an unavailable memory database no-ops.
 */
export async function save(
  conversationId: string,
  state: ActivationState,
): Promise<void> {
  const raw = memorySqliteOrNull("saveActivationState");
  if (!raw) return;
  raw
    .query(UPSERT_SQL)
    .run(
      conversationId,
      state.messageId,
      JSON.stringify(state.state),
      JSON.stringify(state.everInjected),
      state.currentTurn,
      state.updatedAt,
    );
}

/**
 * Copy the parent conversation's activation row to a new conversation id.
 * No-op if the parent has no state (e.g. fork happened before any injection).
 *
 * The child row inherits everInjected as-is so previously-attached slugs are
 * not re-injected on the child's first turn — matching the v1 semantics where
 * a fork carries over all in-context memories.
 *
 * Synchronous so it can run inside the fork's copy path. Writes the dedicated
 * memory connection, which is a separate database file from the main-DB fork
 * transaction, so the copy is not atomic with the message and attachment
 * copies; an unavailable memory database no-ops.
 */
export function forkActivationState(
  parentConversationId: string,
  newConversationId: string,
): void {
  const raw = memorySqliteOrNull("forkActivationState");
  if (!raw) return;
  const row = raw
    .query(
      /*sql*/ `SELECT message_id, state_json, ever_injected_json, current_turn, updated_at
         FROM activation_state WHERE conversation_id = ?`,
    )
    .get(parentConversationId) as ActivationStateRow | null;
  if (!row) return;

  raw
    .query(UPSERT_SQL)
    .run(
      newConversationId,
      row.message_id,
      row.state_json,
      row.ever_injected_json,
      row.current_turn,
      row.updated_at,
    );
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
 * run inside the fork's copy path. Writes the dedicated memory connection; an
 * unavailable memory database no-ops.
 */
export function seedForkActivationState(
  newConversationId: string,
  inheritedSlugs: string[],
): void {
  if (inheritedSlugs.length === 0) return;
  const raw = memorySqliteOrNull("seedForkActivationState");
  if (!raw) return;

  const everInjected: EverInjectedEntry[] = inheritedSlugs.map((slug) => ({
    slug,
    turn: 0,
  }));
  raw
    .query(
      /*sql*/ `INSERT INTO activation_state
         (conversation_id, message_id, state_json, ever_injected_json, current_turn, updated_at)
       VALUES (?, ?, '{}', ?, 0, ?)`,
    )
    .run(
      newConversationId,
      `${newConversationId}:turn:0`,
      JSON.stringify(everInjected),
      Date.now(),
    );
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
