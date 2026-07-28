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
 * safe — the redirect simply doesn't fire and the secure prompt is shown. The
 * client re-derives the card itself from persisted history, so nothing UI-facing
 * depends on this surviving a restart. Entries are never cleared during a run:
 * once a card has been raised the redirect stays the right dedup, and a stale
 * entry after connect is harmless (the caller is already connected).
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
