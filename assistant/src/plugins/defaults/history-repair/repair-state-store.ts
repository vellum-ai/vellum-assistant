/**
 * Per-conversation ordering-repair state for the default history-repair module.
 *
 * The `stop` hook recovers from a provider ordering rejection by running a deep
 * repair and asking the loop to retry. That recovery is bounded to one pass per
 * turn: a second consecutive ordering rejection means the repair could not
 * recover the history, so the hook lets the error surface rather than looping.
 *
 * The `stop` hook owns this state end-to-end. It marks a conversation when it
 * issues a repair-retry and clears the mark on any terminal stop — a successful
 * response, a non-ordering rejection, or an exhausted second ordering rejection
 * — i.e. whenever the loop is leaving rather than retrying. A conversation
 * therefore only holds an entry while a repair is in flight, so the store stays
 * bounded without a separate teardown step.
 *
 * This module is side-effect free: importing it only initializes an empty store
 * and registers no plugin.
 */

/** Conversations with a deep-repair pass in flight for the current turn. */
const repairInFlight = new Set<string>();

/** Whether the conversation already attempted a deep repair this turn. */
export function isOrderingRepairAttempted(conversationId: string): boolean {
  return repairInFlight.has(conversationId);
}

/** Record that the conversation issued its one deep-repair retry this turn. */
export function markOrderingRepairAttempted(conversationId: string): void {
  repairInFlight.add(conversationId);
}

/**
 * Clear the conversation's repair mark so the next turn (or run) repairs afresh.
 * The `stop` hook calls this on every terminal stop.
 */
export function clearOrderingRepairAttempted(conversationId: string): void {
  repairInFlight.delete(conversationId);
}

/**
 * Test-only: drop every conversation's repair state so a suite that drives the
 * hook directly starts each case from an empty store.
 */
export function resetRepairStateStoreForTests(): void {
  repairInFlight.clear();
}
