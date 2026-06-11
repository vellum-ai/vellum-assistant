/**
 * Per-conversation empty-response nudge state for the default empty-response
 * module.
 *
 * The `post-model-call` hook recovers from an empty turn after tool use by
 * appending a nudge and asking the loop to re-query. That recovery is bounded
 * to one pass per run: a second empty turn means the nudge could not coax a
 * real answer, so the hook lets the turn end rather than looping.
 *
 * The hook owns this state end-to-end. It marks a conversation when it issues a
 * nudge-retry and clears the mark on any terminal outcome — a real reply, a
 * refusal rewrite, or an exhausted second empty turn — i.e. whenever the run is
 * leaving rather than retrying. A conversation therefore only holds an entry
 * while a nudge is in flight, so the store stays bounded without a separate
 * teardown step.
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
 * `post-model-call` hook calls this on every terminal outcome.
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
