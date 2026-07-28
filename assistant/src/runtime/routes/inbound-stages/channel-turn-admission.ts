/**
 * Channel-turn admission — honor the "queue if busy" send contract for channel
 * inbound turns.
 *
 * Every interactive send path queues a message that arrives while the
 * conversation is mid-turn and runs it once the turn completes (HTTP
 * `/v1/messages` and `route-conversation-post` both call
 * `conversation.enqueueMessage`; see `runtime/CLAUDE.md` "Queue if busy").
 * Channel inbound cannot reuse that queue directly: the queue drains replies
 * onto the SSE event hub, whereas a channel turn delivers its reply back
 * through the provider callback URL (streaming session + `finalizeEventDelivery`
 * + processed/delivery bookkeeping), orchestration that lives in the
 * fire-and-forget background path (`background-dispatch.ts`), not the shared,
 * batching-aware queue drain. Rather than relocate that delivery into the drain
 * — destabilizing the path every surface shares — we DEFER the whole background
 * flow until the conversation's processing lock is free, then run it. Same
 * "process when the current turn completes" guarantee; delivery orchestration
 * kept intact and in one place.
 *
 * Without this, a channel message routed to a busy conversation throws
 * `CONVERSATION_BUSY_MESSAGE` inside `processMessage`, which the background
 * dispatcher records as a processing failure; `classifyError` treats that
 * message as fatal, so the event is dead-lettered on the first try and never
 * retried — a silent drop with no evaluation (JARVIS-1346). A Slack
 * thread-participant reply routes to the same thread-scoped conversation the
 * assistant's session is running in, so it hit this every time a session was
 * in flight.
 *
 * {@link withChannelTurnAdmission} serializes channel turns per conversation
 * (FIFO, so replies to one conversation stay ordered) and waits for the
 * processing lock to release before invoking `run`. It never gives up: an
 * in-flight turn always eventually releases the lock (`runAgentLoop`'s
 * `finally`), matching how a queued message waits for its drain.
 */
import { findConversation } from "../../../daemon/conversation-registry.js";
import { getLogger } from "../../../util/logger.js";
import { createKeyedSingleFlight } from "../../../util/single-flight.js";

const log = getLogger("channel-turn-admission");

/**
 * Longest a single `waitForIdle` slice blocks before the admission loop
 * re-reads the conversation's state. Idle release is event-driven (the wait
 * resolves the instant the lock frees), so this slice only bounds how quickly
 * we notice a conversation that was evicted or disposed while we waited — its
 * idle waiters would never fire, so the loop re-reads `findConversation` and
 * admits.
 */
const IDLE_WAIT_SLICE_MS = 30_000;

const runChannelTurnSingleFlight = createKeyedSingleFlight();

/**
 * Run `run` — a channel turn plus its reply delivery — once the conversation is
 * free to accept it. Channel turns for the same conversation execute one at a
 * time in arrival order; a turn that arrives while the conversation is mid-turn
 * waits for the processing lock to release instead of being dropped.
 *
 * The single-flight slot is held for the whole of `run` (turn + delivery), so
 * the next channel message for the same conversation is not admitted until this
 * one has finished delivering — keeping same-conversation replies ordered.
 */
export async function withChannelTurnAdmission<T>(
  conversationId: string,
  run: () => Promise<T>,
): Promise<T> {
  return runChannelTurnSingleFlight(conversationId, async () => {
    await waitUntilConversationIdle(conversationId);
    return run();
  });
}

async function waitUntilConversationIdle(
  conversationId: string,
): Promise<void> {
  let deferred = false;
  for (;;) {
    const conversation = findConversation(conversationId);
    // A non-resident conversation is not mid-turn: `processMessage` will
    // hydrate and lock it. Its own lock check is the authoritative guard, so a
    // turn that races in after this point surfaces as a busy error the caller
    // routes to the retry sweep rather than a drop.
    if (!conversation || !conversation.isProcessing()) {
      if (deferred) {
        log.info(
          { conversationId },
          "Channel turn admitted after waiting for the in-flight turn to finish",
        );
      }
      return;
    }
    if (!deferred) {
      deferred = true;
      log.info(
        { conversationId },
        "Channel turn deferred: conversation is mid-turn, waiting for it to finish",
      );
    }
    await conversation.waitForIdle({ timeoutMs: IDLE_WAIT_SLICE_MS });
  }
}

/**
 * Clear the per-conversation single-flight chain. Test-only; production entries
 * self-clear once nothing is waiting behind them.
 *
 * @internal
 */
export function __resetChannelTurnAdmissionForTests(): void {
  runChannelTurnSingleFlight.reset();
}
