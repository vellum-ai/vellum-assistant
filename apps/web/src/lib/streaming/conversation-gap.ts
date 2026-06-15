/**
 * Per-conversation record of whether the live SSE stream lost contiguity for
 * a conversation — a seq gap (or a daemon generation reset) that the daemon's
 * replay ring could not cover, so events were missed and the rendered
 * transcript may be missing content *below* its highest applied seq.
 *
 * This is the missing precondition for the monotonic merge's "stream ahead"
 * rule (`reconcile-with-seq.ts`). That rule keeps the live local rows whenever
 * the snapshot watermark `S` lags the local seq `L`, on the assumption that
 * the stream applied a *contiguous* prefix up to `L`, so local is a superset
 * of any snapshot at `S < L`. A ring-eviction gap breaks that assumption: the
 * stream applied a non-contiguous suffix, `L` advanced past a hole, and local
 * is no longer a superset. While this flag is set the merge must treat the
 * `/messages` snapshot as authoritative for the conversation so the persisted
 * (hole-free) view heals the gap, instead of keeping the truncated live rows.
 *
 * The flag is set by the SSE consumer when it detects a gap on the active
 * conversation and cleared by the reconcile once the snapshot watermark has
 * caught up to the live frontier (`S >= L`), i.e. the transcript is whole
 * again.
 *
 * `seq` is a single global per-assistant counter, but the flag is tracked
 * per-conversation because the merge it gates is per-conversation. Lifetime
 * mirrors `local-seq` and `reconnect-cursor`: meaningful only within one
 * daemon process and one page session, so it lives in memory and resets on
 * reload.
 */

const gapPendingByConversation = new Set<string>();

/**
 * Mark a conversation's live transcript as having a known gap (missed events
 * the daemon ring could not replay), so the next reconcile takes the server
 * snapshot authoritatively for it.
 */
export function markConversationGap(conversationId: string): void {
  gapPendingByConversation.add(conversationId);
}

/** Whether a conversation has an outstanding (unhealed) stream gap. */
export function hasConversationGap(conversationId: string): boolean {
  return gapPendingByConversation.has(conversationId);
}

/**
 * Clear a conversation's gap marker once an authoritative reconcile has
 * healed the hole (the snapshot watermark caught up to the live frontier).
 */
export function clearConversationGap(conversationId: string): void {
  gapPendingByConversation.delete(conversationId);
}

/** Reset state. Test-only. */
export function __resetConversationGapForTesting(): void {
  gapPendingByConversation.clear();
}
