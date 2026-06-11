/**
 * Per-conversation image-recovery state for the default image-recovery module.
 *
 * The `stop` hook recovers from a provider image-too-large rejection by
 * downscaling the oversized image blocks and asking the loop to retry. That
 * recovery is bounded to one pass per turn: a second consecutive image-too-large
 * rejection means the downscale could not get the image under the provider's
 * cap, so the hook lets the error surface rather than looping.
 *
 * The `stop` hook owns this state end-to-end. It marks a conversation when it
 * issues a recovery-retry and clears the mark on any terminal stop — a
 * successful response, a non-image rejection, or an exhausted second
 * image-too-large rejection — i.e. whenever the loop is leaving rather than
 * retrying. A conversation therefore only holds an entry while a recovery is in
 * flight, so the store stays bounded without a separate teardown step.
 *
 * This module is side-effect free: importing it only initializes an empty store
 * and registers no plugin.
 */

/** Conversations with an image-recovery pass in flight for the current turn. */
const recoveryInFlight = new Set<string>();

/** Whether the conversation already attempted an image recovery this turn. */
export function isImageRecoveryAttempted(conversationId: string): boolean {
  return recoveryInFlight.has(conversationId);
}

/** Record that the conversation issued its one image-recovery retry this turn. */
export function markImageRecoveryAttempted(conversationId: string): void {
  recoveryInFlight.add(conversationId);
}

/**
 * Clear the conversation's recovery mark so the next turn (or run) recovers
 * afresh. The `stop` hook calls this on every terminal stop.
 */
export function clearImageRecoveryAttempted(conversationId: string): void {
  recoveryInFlight.delete(conversationId);
}

/**
 * Test-only: drop every conversation's recovery state so a suite that drives the
 * hook directly starts each case from an empty store.
 */
export function resetImageRecoveryStoreForTests(): void {
  recoveryInFlight.clear();
}
