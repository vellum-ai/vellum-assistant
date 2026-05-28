/**
 * Per-conversation streaming-event sequencing.
 *
 * The streaming architecture (see `.private/plans/streaming-message-architecture.md`)
 * tags every event the daemon emits for a conversation with a monotonically
 * increasing `seq`. The sequence persists for the lifetime of the daemon
 * process — it is keyed by `conversationId`, initialized to `0` on first
 * access, and bumped on every `nextSeq()` call. PR 2 in the plan will
 * persist these sequences to durable storage and reseed from the max
 * persisted value at daemon startup; for now we only need monotonic
 * in-memory uniqueness so reconnecting clients can detect replays.
 *
 * The counter is intentionally a module-level map keyed by conversationId
 * (rather than living on `Conversation` / `AgentLoopConversationContext`)
 * so non-agent-loop emit paths — slash commands, surface broadcasts,
 * aux notifier injections — can stamp `seq` without having to thread the
 * conversation context through every call site.
 */

const seqCounters = new Map<string, number>();

/** Return the next monotonic `seq` for the given conversation. */
export function nextSeq(conversationId: string): number {
  const current = seqCounters.get(conversationId) ?? 0;
  const next = current + 1;
  seqCounters.set(conversationId, next);
  return next;
}

/** Read the current seq counter without advancing it (testing only). */
export function peekSeq(conversationId: string): number {
  return seqCounters.get(conversationId) ?? 0;
}

/** Drop the seq counter for a conversation. Used when a conversation is
 *  evicted/destroyed so process memory does not grow unbounded. */
export function resetSeq(conversationId: string): void {
  seqCounters.delete(conversationId);
}
