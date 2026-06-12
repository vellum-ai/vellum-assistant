/**
 * Per-conversation auto-continue budget for the default max-tokens-continue
 * module.
 *
 * The `post-model-call` hook resumes a turn the provider truncated at its
 * output token limit by appending a continuation nudge and asking the loop to
 * re-query. The recovery is bounded per run: a long output legitimately spans
 * a few continuations (each model call gets a fresh output budget), but a turn
 * that keeps hitting the limit after several resumes is burning tokens without
 * converging, so the hook lets it end and the continuation card surfaces for
 * the user to drive.
 *
 * The two hooks split this state's lifecycle: `post-model-call` consumes a
 * unit of budget each time it issues a continue, and the sibling `stop` hook
 * clears the counter when the turn terminates. A conversation therefore only
 * holds an entry while a run is in flight, and the next run starts with a
 * full budget.
 */

/** Maximum automatic continuations per run before the turn ends terminally. */
export const MAX_TOKENS_AUTO_CONTINUES = 3;

/** Continues consumed this run, keyed by conversation. */
const continuesUsed = new Map<string, number>();

/** Whether the conversation still has auto-continue budget this run. */
export function hasMaxTokensContinueBudget(conversationId: string): boolean {
  return (continuesUsed.get(conversationId) ?? 0) < MAX_TOKENS_AUTO_CONTINUES;
}

/** Consume one unit of the conversation's auto-continue budget. */
export function consumeMaxTokensContinueBudget(conversationId: string): void {
  continuesUsed.set(
    conversationId,
    (continuesUsed.get(conversationId) ?? 0) + 1,
  );
}

/**
 * Clear the conversation's budget counter so the next run starts afresh. The
 * sibling `stop` hook calls this when the turn terminates.
 */
export function clearMaxTokensContinueBudget(conversationId: string): void {
  continuesUsed.delete(conversationId);
}

/**
 * Test-only: drop every conversation's budget state so a suite that drives
 * the hook directly starts each case from an empty store.
 */
export function resetMaxTokensContinueStoreForTests(): void {
  continuesUsed.clear();
}
