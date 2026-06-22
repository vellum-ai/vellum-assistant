/**
 * Per-conversation record of the `seq` the `/messages` snapshot is
 * durably persisted through — "this conversation's transcript reflects
 * every event up to global seq S".
 *
 * The daemon advertises this on the `/messages` response (see
 * `assistant/src/runtime/assistant-stream-state.ts`). It is the server's
 * view of the conversation: a client can align the two views by treating
 * the snapshot as authoritative through S and applying only `/events` with
 * `seq > S`.
 *
 * This module only stores the value. It is consumed by:
 *   - the monotonic snapshot/stream merge, which gates a snapshot at
 *     seq S from regressing entities the live stream advanced past S; and
 *   - cold-start/reconnect cursor anchoring, which opens `/events` with
 *     `lastSeenSeq = S` so the daemon replays `seq > S` from its ring.
 *
 * Lifetime mirrors the daemon's in-memory seq space and the
 * `reconnect-cursor`: the value is only meaningful within one daemon
 * process and one page session, so it lives in memory and resets on
 * reload. Persisting it would dangle against a restarted daemon's
 * counter (which restarts at 1) and manufacture false gaps.
 *
 * `null` means "no honest server position" — consumers fall back to
 * today's cold-start behavior (no alignment, no gating).
 *
 * The map grows by distinct conversations visited within a single page
 * session (bounded by navigation, not by stream volume); each snapshot
 * load overwrites the same conversation's entry.
 */

const serverSeqByConversation = new Map<string, number>();

/**
 * Record the server seq advertised by `/messages` for a conversation.
 * A `null`/`undefined`/non-finite value clears any stored position so
 * consumers see "no honest position" rather than reusing a stale seq
 * from an earlier snapshot.
 */
export function recordServerSeq(
  conversationId: string,
  seq: number | null | undefined,
): void {
  if (typeof seq === "number" && Number.isFinite(seq)) {
    serverSeqByConversation.set(conversationId, seq);
    return;
  }
  serverSeqByConversation.delete(conversationId);
}

/**
 * The server seq last recorded for a conversation, or `null` when none
 * is known (never loaded, or the daemon reported no honest position).
 */
export function getServerSeq(conversationId: string): number | null {
  return serverSeqByConversation.get(conversationId) ?? null;
}

/** Reset state. Test-only. */
export function __resetServerSeqForTesting(): void {
  serverSeqByConversation.clear();
}
