/**
 * Per-conversation PR link state for the default pr-link-injector plugin.
 *
 * The `post-tool-use` hook detects `git push` in bash tool calls and resolves
 * the PR URL via the GitHub API. The URL is stored here so the
 * `post-model-call` hook can check whether the model already mentioned it in
 * its reply text and, if not, append it.
 *
 * The `stop` hook clears the entry when the turn terminates so the next run
 * starts fresh.
 */

/** PR URLs discovered during this run, keyed by conversation ID. */
const prLinks = new Map<string, string>();

/** Get the PR URL for a conversation, if one was discovered this run. */
export function getPrLink(conversationId: string): string | undefined {
  return prLinks.get(conversationId);
}

/** Store the PR URL for a conversation. */
export function setPrLink(conversationId: string, url: string): void {
  prLinks.set(conversationId, url);
}

/** Clear the PR URL for a conversation. Called by the `stop` hook. */
export function clearPrLink(conversationId: string): void {
  prLinks.delete(conversationId);
}

/** Test-only: drop all PR link state. */
export function resetPrLinkStoreForTests(): void {
  prLinks.clear();
}
