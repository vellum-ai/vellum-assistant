/**
 * The drain's check on queued messages from shared-conversation contacts.
 *
 * A contact's message can wait in the queue long after the route accepted
 * it, and the contact can be removed or revoked meanwhile. Before the drain
 * dequeues anything, the message about to run is checked again:
 *
 * - admitted: it runs.
 * - denied (no longer a participant, or the gateway refuses them): it is
 *   dropped, never persisted or run.
 * - unverifiable (the trust read failed): it is not run and not dropped. It
 *   steps aside so other senders' messages queued behind it, the guardian's
 *   included, run in order, while the same sender's later messages stay
 *   behind it. A delayed re-drain asks again with backoff. After a few
 *   consecutive failures, or once it has waited too long, it is dropped:
 *   a contact who cannot be verified never gets a turn.
 *
 * A dropped row gets the terminal `message_queued_deleted` its queued ack
 * owes, so no client keeps showing it; nothing else is announced.
 */

import { isSuppressedQueuedMessage } from "../persistence/conversation-types.js";
import { getLogger } from "../util/logger.js";
import type { Conversation } from "./conversation.js";
import type { QueuedMessage } from "./conversation-queue-manager.js";

const log = getLogger("shared-sender-queue-gate");

/** Consecutive unverifiable reads after which a message is dropped. */
export const MAX_UNVERIFIABLE_ATTEMPTS = 4;

/** How long a message may stay unverifiable before it is dropped. */
const MAX_UNVERIFIABLE_AGE_MS = 2 * 60 * 1000;

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), 15_000);
}

let retryDelayMs = defaultRetryDelayMs;

/** Consecutive unverifiable reads per waiting message. */
const unverifiable = new WeakMap<
  QueuedMessage,
  { attempts: number; firstAt: number }
>();

/** The pending re-drain per conversation, so a burst schedules one. */
const pendingRetries = new WeakMap<object, ReturnType<typeof setTimeout>>();

type GatedConversation = Pick<
  Conversation,
  "conversationId" | "queue" | "isProcessing" | "kickDrainQueue"
>;

/**
 * The principal of a shared-conversation contact who sent this queued
 * message, or undefined for any other sender. A contact's message is the one
 * whose author the shared send route stamped on the `vellum-shared` channel;
 * its principal is the verified actor the route queued it for. A contact
 * message missing that principal answers the empty string, which the check
 * refuses.
 */
function sharedSenderPrincipal(queued: QueuedMessage): string | undefined {
  if (queued.author?.sourceChannel !== "vellum-shared") {
    return undefined;
  }
  return queued.sourceActorPrincipalId ?? "";
}

function drop(
  conversation: GatedConversation,
  queued: QueuedMessage,
  principalId: string,
  why: "denied" | "unverifiable",
): void {
  conversation.queue.removeByRequestId(queued.requestId);
  unverifiable.delete(queued);
  const fields = {
    conversationId: conversation.conversationId,
    principalId,
    requestId: queued.requestId,
  };
  if (why === "denied") {
    log.info(
      fields,
      "Dropped a queued message: its sender no longer has access to the conversation",
    );
  } else {
    log.warn(
      fields,
      "Dropped a queued message: its sender could not be verified after repeated attempts",
    );
  }
  if (!isSuppressedQueuedMessage(queued.metadata)) {
    queued.onEvent({
      type: "message_queued_deleted",
      conversationId: conversation.conversationId,
      requestId: queued.requestId,
      ...(queued.clientMessageId
        ? { clientMessageId: queued.clientMessageId }
        : {}),
    });
  }
}

function scheduleRetry(conversation: GatedConversation, attempt: number) {
  if (pendingRetries.has(conversation)) {
    return;
  }
  const timer = setTimeout(() => {
    pendingRetries.delete(conversation);
    // A running turn drains the queue itself when it ends.
    if (!conversation.isProcessing()) {
      void conversation.kickDrainQueue("loop_complete", "shared_sender_retry");
    }
  }, retryDelayMs(attempt));
  timer.unref?.();
  pendingRetries.set(conversation, timer);
}

/**
 * Settle the message the drain is about to take. Answers true with an
 * admitted message, or a message from any other sender, at the head of the
 * queue; false when every queued message is a contact's that cannot be
 * verified yet, in which case the drain stops and the scheduled retry resumes
 * it.
 */
export async function gateSharedSenderHead(
  conversation: GatedConversation,
): Promise<boolean> {
  // Senders with a message waiting on a retry. Every later message of theirs
  // waits behind it, so one sender's messages never run out of order.
  const waiting = new Set<string>();
  for (;;) {
    const next = conversation.queue.snapshot().find((queued) => {
      const sender = sharedSenderPrincipal(queued);
      return sender === undefined || !waiting.has(sender);
    });
    if (!next) {
      return waiting.size === 0;
    }
    const principalId = sharedSenderPrincipal(next);
    if (principalId === undefined) {
      conversation.queue.promoteToHead(next.requestId);
      return true;
    }

    let outcome: "admitted" | "denied" | "unverifiable";
    try {
      const { checkSharedSender } =
        await import("../runtime/shared-sender-admission.js");
      outcome = (
        await checkSharedSender(conversation.conversationId, principalId)
      ).outcome;
    } catch (err) {
      log.warn(
        { err, conversationId: conversation.conversationId, principalId },
        "Shared sender admission check failed",
      );
      outcome = "unverifiable";
    }
    // The check awaited; a message removed meanwhile is not ours to settle.
    if (conversation.queue.findByRequestId(next.requestId) !== next) {
      continue;
    }

    if (outcome === "admitted") {
      unverifiable.delete(next);
      conversation.queue.promoteToHead(next.requestId);
      return true;
    }
    if (outcome === "denied") {
      drop(conversation, next, principalId, "denied");
      continue;
    }
    const now = Date.now();
    const state = unverifiable.get(next) ?? { attempts: 0, firstAt: now };
    state.attempts += 1;
    unverifiable.set(next, state);
    if (
      state.attempts >= MAX_UNVERIFIABLE_ATTEMPTS ||
      now - state.firstAt >= MAX_UNVERIFIABLE_AGE_MS
    ) {
      drop(conversation, next, principalId, "unverifiable");
      continue;
    }
    waiting.add(principalId);
    scheduleRetry(conversation, state.attempts);
  }
}

/** Test-only: replace the retry backoff, or restore it with no argument. */
export function __setSharedSenderRetryDelayForTest(
  delay?: (attempt: number) => number,
): void {
  retryDelayMs = delay ?? defaultRetryDelayMs;
}
