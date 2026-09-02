/**
 * Per-conversation injection-echo reject state for the default
 * injection-echo-reject module.
 *
 * The `post-model-call` hook rejects a completion that opens with a reserved
 * runtime-injection envelope, appends a nudge, and asks the loop to re-query.
 * That recovery is bounded to one pass per run: a second reserved opener means
 * the nudge could not coax a normal reply, so the hook lets the turn end
 * rather than looping.
 *
 * The two hooks split this state's lifecycle: `post-model-call` marks a
 * conversation when it issues a reject-retry, and the sibling `stop` hook
 * clears the mark when the turn terminates. A conversation therefore only
 * holds an entry while a reject is in flight, and the next run rejects afresh.
 *
 * This module is side-effect free: importing it only initializes an empty store
 * and registers no plugin.
 */

/** Conversations with an injection-echo reject in flight for the current run. */
const rejectInFlight = new Set<string>();

/** Whether the conversation already issued its one reject this run. */
export function isInjectionEchoRejected(conversationId: string): boolean {
  return rejectInFlight.has(conversationId);
}

/** Record that the conversation issued its one reject-retry this run. */
export function markInjectionEchoRejected(conversationId: string): void {
  rejectInFlight.add(conversationId);
}

/**
 * Clear the conversation's reject mark so the next run rejects afresh. The
 * sibling `stop` hook calls this when the turn terminates.
 */
export function clearInjectionEchoRejected(conversationId: string): void {
  rejectInFlight.delete(conversationId);
}

/**
 * Test-only: drop every conversation's reject state so a suite that drives the
 * hook directly starts each case from an empty store.
 */
export function resetInjectionEchoRejectStoreForTests(): void {
  rejectInFlight.clear();
}
