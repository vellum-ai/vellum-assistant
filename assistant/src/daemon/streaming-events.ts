/**
 * Per-conversation streaming-event sequencing.
 *
 * The streaming architecture (see `.private/plans/streaming-message-architecture.md`)
 * tags every event the daemon emits for a conversation with a monotonically
 * increasing `seq`. The sequence persists across daemon restarts and
 * conversation evictions via the durable `conversation_events` table:
 * `nextSeq` lazily reseeds the in-memory counter from the max persisted
 * `seq` the first time a conversation surfaces (after boot, or after an
 * eviction that called {@link resetSeq}). Subsequent calls bump the
 * in-memory counter without touching the DB.
 *
 * Reseeding from durable state is required so post-eviction emits cannot
 * collide with rows the previous incarnation already wrote — replay
 * relies on `(conversation_id, seq)` being globally unique within the
 * retention window.
 *
 * The counter is intentionally a module-level map keyed by conversationId
 * (rather than living on `Conversation` / `AgentLoopConversationContext`)
 * so non-agent-loop emit paths — slash commands, surface broadcasts,
 * aux notifier injections — can stamp `seq` without having to thread the
 * conversation context through every call site.
 */

import { maxSeqForConversation } from "./event-log.js";

const seqCounters = new Map<string, number>();

/**
 * Return the next monotonic `seq` for the given conversation.
 *
 * On first access for a conversation, the counter is seeded from the max
 * persisted `seq` in `conversation_events` so a daemon restart or a
 * post-eviction re-entry cannot replay an existing seq value.
 */
export function nextSeq(conversationId: string): number {
  let current = seqCounters.get(conversationId);
  if (current === undefined) {
    current = maxSeqForConversation(conversationId);
  }
  const next = current + 1;
  seqCounters.set(conversationId, next);
  return next;
}

/** Read the current seq counter without advancing it (testing only). */
export function peekSeq(conversationId: string): number {
  return seqCounters.get(conversationId) ?? 0;
}

/** Drop the seq counter for a conversation. Used when a conversation is
 *  evicted/destroyed so process memory does not grow unbounded. The next
 *  `nextSeq` for this conversation will reseed from durable storage. */
export function resetSeq(conversationId: string): void {
  seqCounters.delete(conversationId);
}
