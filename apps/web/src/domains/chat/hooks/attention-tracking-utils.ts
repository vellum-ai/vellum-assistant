/** Pure helper functions for attention tracking.
 *
 *  Separated from the React hook (`useAttentionTracking`) so they can
 *  be unit-tested without a component render cycle. */

export type GraduationAction =
  | { type: "ADD_ATTENTION_KEY"; key: string }
  | { type: "REMOVE_PROCESSING_KEY"; key: string };

/**
 * Decide which conversation-list actions to dispatch for a batch of graduating
 * processing keys after a bulk pending-interactions fetch.
 *
 * Pass `pendingKeys = null` to signal "we don't know" (bulk fetch failed). In
 * that case this returns no actions so the keys stay in `processingConversationIds` with
 * their snapshots intact; the next render will retry. Graduating without
 * pending-state knowledge would risk silently dropping the processing
 * indicator on a conversation that actually has a pending approval.
 *
 * Pass `pendingKeys` as a Set when the fetch succeeded. Every graduating key
 * is removed from `processingConversationIds`; ones that are pending also get added to
 * `attentionConversationIds` first (the red-dot indicator).
 */
export function decideGraduationDispatches(
  graduatingKeys: readonly string[],
  pendingKeys: ReadonlySet<string> | null,
): GraduationAction[] {
  if (pendingKeys === null) return [];
  const actions: GraduationAction[] = [];
  for (const key of graduatingKeys) {
    if (pendingKeys.has(key)) actions.push({ type: "ADD_ATTENTION_KEY", key });
    actions.push({ type: "REMOVE_PROCESSING_KEY", key });
  }
  return actions;
}
