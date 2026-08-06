/**
 * Per-conversation serialization for the detached end-of-turn tails the agent
 * loop schedules after releasing the processing lock.
 *
 * The chain is keyed by conversation id and held at module scope rather than
 * on the `Conversation` instance. A tail runs while the conversation reads
 * idle, which is exactly the window in which `evictConversationsForReload` and
 * the stale-instance rebuild in `conversation-store.ts` drop the live instance:
 * an instance-scoped chain would let the rebuilt instance start an empty chain
 * whose tail overlaps the previous instance's still-running one. The state
 * those tails advance (memory segments, the conversation attention cursor) is
 * per conversation, not per instance, so the serialization has to be too.
 */

import { getLogger } from "../util/logger.js";

const log = getLogger("turn-tail-chain");

/** Tail promise per conversation id. Entries exist only while a tail is live. */
const chains = new Map<string, Promise<void>>();

/**
 * Queue `tail` behind any tail already running for this conversation.
 *
 * Returns immediately: the tail is detached by design, so its failure is
 * logged rather than surfaced. The chain is `.catch`-terminated at every link,
 * so a rejected tail can neither become an unhandled rejection nor poison the
 * tails queued after it.
 */
export function chainTurnTail(
  conversationId: string,
  tail: () => Promise<void>,
): void {
  const previous = chains.get(conversationId) ?? Promise.resolve();
  const next: Promise<void> = previous
    .then(tail)
    .catch((err: unknown) => {
      log.warn(
        { err, conversationId },
        "Deferred turn tail failed (non-fatal)",
      );
    })
    .then(() => {
      // Drop the entry only when nothing chained onto this link while it ran,
      // so the map holds an entry per conversation with a live tail rather
      // than one per conversation the daemon has ever served.
      if (chains.get(conversationId) === next) {
        chains.delete(conversationId);
      }
    });
  chains.set(conversationId, next);
}

/**
 * Resolve once every tail currently queued for this conversation has settled.
 *
 * Tests use this to await work the agent loop deliberately detached. Callers
 * that chain a new tail after awaiting get a fresh promise, so this is a
 * point-in-time barrier, not a permanent quiesce.
 */
export function settleTurnTail(conversationId: string): Promise<void> {
  return chains.get(conversationId) ?? Promise.resolve();
}

/**
 * Number of conversations with a live tail. Lets tests assert the map is
 * released rather than growing per conversation.
 *
 * @internal
 */
export function __turnTailChainSizeForTests(): number {
  return chains.size;
}
