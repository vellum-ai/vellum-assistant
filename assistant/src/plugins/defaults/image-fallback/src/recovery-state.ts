/**
 * Per-conversation vision-recovery state for the image-fallback plugin.
 *
 * The `post-model-call` hook recovers from a provider vision-not-supported
 * rejection by captioning the raw image blocks in the working history and
 * asking the loop to retry. That recovery is bounded to one pass per turn: a
 * second consecutive vision rejection means captioning could not clear the
 * request of image input (e.g. a path the sweep cannot reach), so the hook
 * lets the error surface rather than looping.
 *
 * The `post-model-call` hook marks a conversation when it issues a
 * recovery-retry and the `stop` hook clears the mark on any terminal stop —
 * a finalized reply, an unrecovered rejection, or an abort — i.e. whenever
 * the loop is leaving rather than retrying. A conversation therefore only
 * holds an entry while a recovery is in flight, so the store stays bounded
 * without a separate teardown step.
 *
 * This module is side-effect free: importing it only initializes an empty
 * store and registers no plugin.
 */

/** Conversations with a vision-recovery pass in flight for the current turn. */
const recoveryInFlight = new Set<string>();

/** Whether the conversation already attempted a vision recovery this turn. */
export function isVisionRecoveryAttempted(conversationId: string): boolean {
  return recoveryInFlight.has(conversationId);
}

/** Record that the conversation issued its one vision-recovery retry this turn. */
export function markVisionRecoveryAttempted(conversationId: string): void {
  recoveryInFlight.add(conversationId);
}

/**
 * Clear the conversation's recovery mark so the next turn (or run) recovers
 * afresh. The `stop` hook calls this on every terminal stop.
 */
export function clearVisionRecoveryAttempted(conversationId: string): void {
  recoveryInFlight.delete(conversationId);
}

/**
 * Test-only: drop every conversation's recovery state so a suite that drives
 * the hook directly starts each case from an empty store.
 */
export function resetVisionRecoveryStoreForTests(): void {
  recoveryInFlight.clear();
}
