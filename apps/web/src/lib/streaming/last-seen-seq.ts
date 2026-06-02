/**
 * Per-conversation `clientSeq` watermark for gap detection.
 *
 * Tracks the highest `clientSeq` applied from the SSE stream for each
 * conversation. `clientSeq` is the subscriber-filtered sequence number
 * the daemon stamps per conversation per subscriber — gap-free by
 * construction, so a jump of more than one signals lost events and the
 * consumer triggers a reconcile/refetch (see `sse-event-consumer.ts`).
 *
 * `clientSeq` resets on every new SSE subscription (the daemon starts a
 * fresh counter per subscriber), so this watermark is meaningful only
 * within the lifetime of one subscription and is held in memory only —
 * a value persisted across page loads would belong to a stale
 * subscription. Gap detection re-seeds the watermark from the first
 * event of each subscription regardless of any prior value.
 *
 * Writes are monotonic — `setLastSeenSeq` only updates when the new
 * value is strictly greater than the current value. `replaceLastSeenSeq`
 * unconditionally replaces the watermark; used to re-seed on a new
 * subscription, where the incoming `clientSeq` may be lower than the
 * previous subscription's final value.
 *
 * The in-memory map is capped at {@link MAX_TRACKED_CONVERSATIONS}.
 * When the cap is exceeded, the oldest entry (Map iteration order =
 * insertion order) is evicted. Every write promotes the conversation to
 * the end of the map so recently-active conversations are retained.
 */

/** Visible for testing. */
export const MAX_TRACKED_CONVERSATIONS = 256;

const seqMap = new Map<string, number>();

/**
 * Read the watermark for a conversation.
 * Returns `null` if none has been recorded.
 */
export function getLastSeenSeq(conversationId: string): number | null {
  return seqMap.get(conversationId) ?? null;
}

/**
 * Write a watermark value, promote the conversation to the end of the
 * Map (LRU), and evict the oldest entry if over capacity.
 */
function writeThrough(conversationId: string, seq: number): void {
  // Delete-then-set promotes to the end of Map iteration order.
  seqMap.delete(conversationId);
  seqMap.set(conversationId, seq);

  if (seqMap.size > MAX_TRACKED_CONVERSATIONS) {
    const oldest = seqMap.keys().next().value;
    if (oldest != null) {
      seqMap.delete(oldest);
    }
  }
}

/**
 * Record a watermark for a conversation. Only writes if `seq` is
 * strictly greater than the current value (monotonic).
 */
export function setLastSeenSeq(conversationId: string, seq: number): void {
  const current = seqMap.get(conversationId);
  if (current !== undefined && seq <= current) {
    return;
  }
  writeThrough(conversationId, seq);
}

/**
 * Unconditionally replace the watermark for a conversation. Used to
 * re-seed when a new subscription begins (its `clientSeq` may be lower
 * than the prior subscription's final value). Unlike `setLastSeenSeq`,
 * this does not enforce monotonicity.
 */
export function replaceLastSeenSeq(conversationId: string, seq: number): void {
  writeThrough(conversationId, seq);
}

/**
 * Clear the watermark for a conversation. Used when a conversation
 * becomes active to avoid spurious gap detection from a stale
 * watermark after a conversation switch.
 */
export function clearLastSeenSeq(conversationId: string): void {
  seqMap.delete(conversationId);
}

/** Snapshot of all in-memory watermarks. Keyed by conversationId. Debug-only. */
export function getGapDetectionCursors(): Record<string, number> {
  return Object.fromEntries(seqMap);
}

/** Reset all state. Test-only. */
export function __resetLastSeenSeqForTesting(): void {
  seqMap.clear();
}
