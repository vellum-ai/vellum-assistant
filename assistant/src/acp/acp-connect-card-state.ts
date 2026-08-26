/**
 * Tracks which conversations have raised an inline "Connect Claude Code" card
 * (a missing-token `acp_spawn` failure carrying the `acp_claude_oauth_missing`
 * marker).
 *
 * The credential-prompt route uses this so it only redirects a redundant
 * secure-prompt for `acp/claude_oauth_token` when a card actually exists. Without
 * it, a proactive `credentials prompt` (a setup flow, or the model, calling
 * before any spawn failure) would be told "click Connect" against a card that
 * was never raised — and the secure prompt it needed would be suppressed,
 * leaving auth unset.
 *
 * In-memory and ephemeral by design: a daemon restart clears it, which fails
 * safe. The redirect simply doesn't fire and the secure prompt is shown.
 *
 * Cleared for real on a successful token write (`storeAcpClaudeToken`), which
 * is the moment the cards these entries stand for stop being the right place
 * to send anyone. Left standing, the redirect keeps pointing the model at a
 * card for auth that already works, and the persisted history markers the
 * entries name keep re-raising it on every reload.
 */
const conversationsWithAcpConnectCard = new Set<string>();

/** Record that a Connect Claude card was raised for this conversation. */
export function markAcpConnectCardRaised(
  conversationId: string | undefined,
): void {
  if (conversationId) {
    conversationsWithAcpConnectCard.add(conversationId);
  }
}

/** Whether a Connect Claude card has been raised for this conversation. */
export function hasAcpConnectCardRaised(
  conversationId: string | undefined,
): boolean {
  return (
    conversationId != null &&
    conversationsWithAcpConnectCard.has(conversationId)
  );
}

/**
 * Hand back every conversation that raised a card and forget them all.
 *
 * Take-and-clear rather than a read plus a separate reset: the caller is
 * retiring these conversations' persisted markers, and an entry left behind
 * after that would redirect the secure-prompt fallback at a card nothing can
 * re-raise.
 */
export function takeConversationsWithAcpConnectCard(): string[] {
  const conversationIds = [...conversationsWithAcpConnectCard];
  conversationsWithAcpConnectCard.clear();
  return conversationIds;
}
