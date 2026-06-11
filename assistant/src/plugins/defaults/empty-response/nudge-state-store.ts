/**
 * Per-conversation empty-response nudge state for the default empty-response
 * module.
 *
 * The `post-model-call` hook recovers from an empty turn after tool use by
 * appending a nudge and asking the loop to re-query. That recovery is bounded
 * to one pass per run: a second empty turn means the nudge could not coax a
 * real answer, so the hook lets the turn end rather than looping.
 *
 * The two hooks split this state's lifecycle: `post-model-call` marks a
 * conversation when it issues a nudge-retry, and the sibling `stop` hook clears
 * the mark when the turn terminates. A conversation therefore only holds an
 * entry while a nudge is in flight, and the next run always nudges afresh.
 *
 * This module is side-effect free: importing it only initializes an empty store
 * and registers no plugin.
 */

/** Conversations with an empty-response nudge in flight for the current run. */
const nudgeInFlight = new Set<string>();

/** Whether the conversation already issued its one nudge this run. */
export function isEmptyResponseNudged(conversationId: string): boolean {
  return nudgeInFlight.has(conversationId);
}

/** Record that the conversation issued its one nudge-retry this run. */
export function markEmptyResponseNudged(conversationId: string): void {
  nudgeInFlight.add(conversationId);
}

/**
 * Clear the conversation's nudge mark so the next run nudges afresh. The
 * sibling `stop` hook calls this when the turn terminates.
 */
export function clearEmptyResponseNudged(conversationId: string): void {
  nudgeInFlight.delete(conversationId);
}

/**
 * Test-only: drop every conversation's nudge state so a suite that drives the
 * hook directly starts each case from an empty store.
 */
export function resetEmptyResponseNudgeStoreForTests(): void {
  nudgeInFlight.clear();
}
