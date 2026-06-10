/**
 * Per-conversation ordering-repair state for the default history-repair module.
 *
 * The `stop` hook recovers from a provider ordering rejection by running a deep
 * repair and asking the loop to retry. That recovery is bounded to one pass per
 * turn: a second consecutive ordering rejection means the repair could not
 * recover the history, so the hook lets the error surface rather than looping.
 * This store holds that one-shot flag per conversation, keeping the bound owned
 * by the plugin rather than the loop.
 *
 * Mirrors the compaction module's {@link createContextWindowManager} store: a
 * per-conversation object keyed by conversation id, lazily initialized on first
 * access, reset at the turn boundary, and dropped when the conversation is torn
 * down so the store doesn't grow unbounded.
 *
 * This module is side-effect free: importing it only initializes an empty store
 * and registers no plugin.
 */

/** Turn-scoped ordering-repair state for one conversation. */
export interface RepairState {
  /**
   * Whether a deep-repair pass has already run for the in-flight turn's
   * ordering rejection. Set when the `stop` hook repairs and retries; reset at
   * the turn boundary so a later turn repairs independently.
   */
  orderingRepairAttempted: boolean;
}

/** Live repair state keyed by conversation id. */
const stateByConversation = new Map<string, RepairState>();

/**
 * Resolve the conversation's repair state, creating a fresh one on first
 * access. The store is the single owner; the `stop` hook reads and mutates the
 * returned object directly.
 */
export function getRepairState(conversationId: string): RepairState {
  let state = stateByConversation.get(conversationId);
  if (!state) {
    state = { orderingRepairAttempted: false };
    stateByConversation.set(conversationId, state);
  }
  return state;
}

/**
 * Clear the turn-scoped flag at the turn boundary so the next turn's ordering
 * rejection can repair afresh rather than being treated as already attempted.
 */
export function resetRepairState(conversationId: string): void {
  const state = stateByConversation.get(conversationId);
  if (state) {
    state.orderingRepairAttempted = false;
  }
}

/**
 * Release the conversation's repair state. Called from conversation teardown so
 * the store releases the entry once the conversation is gone.
 */
export function disposeRepairState(conversationId: string): void {
  stateByConversation.delete(conversationId);
}

/**
 * Test-only: drop every conversation's repair state so a suite that drives the
 * loop directly (without the wrapper's turn-boundary reset) starts each case
 * from an empty store.
 */
export function resetRepairStateStoreForTests(): void {
  stateByConversation.clear();
}
