/**
 * Per-conversation record of the highest global `seq` the live transcript
 * has applied for a conversation — "this conversation's on-screen state
 * reflects every event up to global seq L".
 *
 * This is the stream-side counterpart to `server-seq.ts`. Where the server
 * seq (`S`) is how far the durable `/messages` snapshot has caught up, the
 * local seq (`L`) is how far the live SSE stream has advanced the rendered
 * conversation. The two together drive the monotonic merge:
 *   - When `S >= L` the snapshot has seen everything the stream applied,
 *     so it is authoritative.
 *   - When `S < L` the stream is ahead of the snapshot; applying the
 *     snapshot's stale view would regress content the stream already
 *     rendered, so the live tail is kept.
 *
 * It also makes stream apply idempotent: an event whose `seq <= L` for its
 * conversation has already been applied, so re-delivering it (replay after
 * reconnect, overlap with a reconcile) is a guaranteed no-op.
 *
 * `seq` is a single global per-assistant counter, but `L` is tracked
 * per-conversation rather than globally because the rendered state the
 * merge protects is per-conversation: the stream only advances the active
 * conversation's transcript, and a global frontier would sit above any one
 * conversation's last applied event as soon as another conversation
 * interleaved, manufacturing false "stream is ahead" decisions.
 *
 * Lifetime mirrors `server-seq` and `reconnect-cursor`: the value is only
 * meaningful within one daemon process and one page session, so it lives in
 * memory and resets on reload. The map grows by distinct conversations
 * visited within a page session (bounded by navigation, not stream volume).
 */

const localSeqByConversation = new Map<string, number>();

/**
 * Advance the local seq for a conversation to `seq` when it is higher than
 * the current value (monotonic). Called after a stream event is applied to
 * the conversation, and after a snapshot is applied (with the snapshot's
 * seq) so the local seq reflects both apply paths.
 *
 * A `null`/`undefined`/non-finite `seq` is ignored — there is nothing to
 * advance to.
 */
export function recordLocalSeq(
  conversationId: string,
  seq: number | null | undefined,
): void {
  if (typeof seq !== "number" || !Number.isFinite(seq)) {
    return;
  }
  const current = localSeqByConversation.get(conversationId);
  if (current === undefined || seq > current) {
    localSeqByConversation.set(conversationId, seq);
  }
}

/**
 * The local seq last recorded for a conversation, or `null` when none is
 * known (never streamed to within this page session).
 */
export function getLocalSeq(conversationId: string): number | null {
  return localSeqByConversation.get(conversationId) ?? null;
}

/** Reset state. Test-only. */
export function __resetLocalSeqForTesting(): void {
  localSeqByConversation.clear();
}
