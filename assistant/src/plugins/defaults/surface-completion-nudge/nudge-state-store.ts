/**
 * Per-conversation surface-completion nudge state.
 *
 * The `post-model-call` hook nudges the model — once per run — to complete or
 * dismiss a progress surface it left `in_progress` when the turn was about to
 * end, asking the loop to re-query so the model can act on it. That nudge is
 * bounded to one pass per run: if the model declines or fails to close the
 * surface, the hook lets the turn end rather than looping on it.
 *
 * The two hooks split this state's lifecycle: `post-model-call` marks a
 * conversation when it issues the nudge, and the sibling `stop` hook clears the
 * mark when the turn terminates. A conversation therefore only holds an entry
 * while a nudge is in flight, and the next run nudges afresh.
 *
 * This module is side-effect free: importing it only initializes an empty store
 * and registers no plugin.
 */

/** Conversations with a surface-completion nudge in flight for the current run. */
const nudgeInFlight = new Set<string>();

/** Whether the conversation already issued its one nudge this run. */
export function isSurfaceCompletionNudged(conversationId: string): boolean {
  return nudgeInFlight.has(conversationId);
}

/** Record that the conversation issued its one nudge this run. */
export function markSurfaceCompletionNudged(conversationId: string): void {
  nudgeInFlight.add(conversationId);
}

/**
 * Clear the conversation's nudge mark so the next run nudges afresh. The
 * sibling `stop` hook calls this when the turn terminates.
 */
export function clearSurfaceCompletionNudged(conversationId: string): void {
  nudgeInFlight.delete(conversationId);
}

/**
 * Test-only: drop every conversation's nudge state so a suite that drives the
 * hook directly starts each case from an empty store.
 */
export function resetSurfaceCompletionNudgeStoreForTests(): void {
  nudgeInFlight.clear();
}
