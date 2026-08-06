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

interface LocalSeqEntry {
  /** Highest global seq applied for the conversation. */
  value: number;
  /**
   * The seq generation the `value` belongs to (see `reconnect-cursor.ts`): the
   * current generation for a live-stream apply, or the generation the
   * `/messages` request was ISSUED in for a snapshot anchor. The stale-frontier
   * guard in `sse-event-consumer` treats a frontier tagged with a generation
   * older than the current one as a dead-generation anchor regardless of its
   * value, which recovers a stale anchor sitting below the abandoned ceiling.
   */
  generation: number;
}

const localSeqByConversation = new Map<string, LocalSeqEntry>();

/**
 * Advance the local seq for a conversation to `seq` when it is higher than
 * the current value (monotonic). Called after a stream event is applied to
 * the conversation, and after a snapshot is applied (with the snapshot's
 * seq) so the local seq reflects both apply paths.
 *
 * `generation` is the seq generation `seq` belongs to — pass the current
 * generation for a live-stream apply, or the request's issue-time generation
 * for a `/messages` snapshot anchor. When the frontier advances it adopts the
 * new value's generation, so the tag always tracks the value in force.
 *
 * A `null`/`undefined`/non-finite `seq` is ignored — there is nothing to
 * advance to.
 */
export function recordLocalSeq(
  conversationId: string,
  seq: number | null | undefined,
  generation: number,
): void {
  if (typeof seq !== "number" || !Number.isFinite(seq)) {
    return;
  }
  const current = localSeqByConversation.get(conversationId);
  if (current === undefined || seq > current.value) {
    localSeqByConversation.set(conversationId, { value: seq, generation });
  }
}

/**
 * The local seq last recorded for a conversation, or `null` when none is
 * known (never streamed to within this page session).
 */
export function getLocalSeq(conversationId: string): number | null {
  return localSeqByConversation.get(conversationId)?.value ?? null;
}

/**
 * The seq generation the conversation's current frontier value belongs to, or
 * `null` when no frontier is recorded. Read by the stale-frontier guard to
 * recognise a dead-generation anchor by construction (older generation).
 */
export function getLocalSeqGeneration(conversationId: string): number | null {
  return localSeqByConversation.get(conversationId)?.generation ?? null;
}

/**
 * Drop every recorded frontier. Called when connection-wide gap detection
 * observes a seq generation reset (the daemon's counter restarted below
 * the stored cursor): frontiers recorded against the old seq space sit
 * above every seq the new space issues, so keeping them would classify
 * all live events as already-applied replays.
 */
export function resetLocalSeqs(): void {
  localSeqByConversation.clear();
}

/**
 * Drop one conversation's frontier. Used when the frontier is discovered
 * to belong to a stale seq generation (see `sse-event-consumer`'s
 * stale-frontier guard) so the live event can apply and re-seed it.
 */
export function clearLocalSeq(conversationId: string): void {
  localSeqByConversation.delete(conversationId);
}

/** Reset state. Test-only. */
export function __resetLocalSeqForTesting(): void {
  resetLocalSeqs();
}
