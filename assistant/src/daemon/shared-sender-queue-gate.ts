/**
 * The drain's check on queued messages from shared-conversation contacts.
 *
 * A contact's message, or the completion of work their turn started, can
 * wait in the queue long after it was accepted, and the contact can be
 * removed or revoked meanwhile. Before the drain
 * dequeues anything, the message about to run is checked again:
 *
 * - admitted: it runs.
 * - denied (no longer a participant, or the gateway refuses them): it is
 *   dropped, never persisted or run.
 * - unverifiable (the trust read failed): it is not run and not dropped. It
 *   steps aside so other senders' messages queued behind it, the guardian's
 *   included, run in order, while the same sender's later messages stay
 *   behind it. A delayed re-drain asks again with backoff, for as long as a
 *   gateway restart could plausibly last. Once it has waited past that, it
 *   is dropped:
 *   a contact who cannot be verified never gets a turn.
 *
 * A dropped row gets the terminal `message_queued_deleted` its queued ack
 * owes, so no client keeps showing it, and the sender's own event stream
 * forwards that close-out to them; nothing else is announced.
 */

import { isSuppressedQueuedMessage } from "../persistence/conversation-types.js";
import { noteDroppedOwnMessage } from "../runtime/contact-event-projection.js";
import type { SharedSenderAdmission } from "../runtime/shared-sender-admission.js";
import { resolveRoutingState } from "../runtime/trust-context-resolver.js";
import { getLogger } from "../util/logger.js";
import {
  restoreActorBeforeContact,
  scopeHistoryToActor,
} from "./actor-scoped-history.js";
import type { Conversation } from "./conversation.js";
import type { QueuedMessage } from "./conversation-queue-manager.js";

const log = getLogger("shared-sender-queue-gate");

/** How long a message may stay unverifiable before it is dropped. */
const DEFAULT_MAX_UNVERIFIABLE_AGE_MS = 30 * 60 * 1000;

/** The longest wait between two checks of an unverifiable message. */
const MAX_RETRY_DELAY_MS = 60_000;

function defaultRetryDelayMs(attempt: number): number {
  return Math.min(1000 * 2 ** (attempt - 1), MAX_RETRY_DELAY_MS);
}

let maxUnverifiableAgeMs = DEFAULT_MAX_UNVERIFIABLE_AGE_MS;
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
  | "conversationId"
  | "queue"
  | "isProcessing"
  | "kickDrainQueue"
  | "trustContext"
  | "setTrustContext"
  | "ensureActorScopedHistory"
>;

/**
 * The principal of a shared-conversation contact who sent this queued
 * message, or undefined for any other sender. A contact's message is the one
 * whose author the shared send route stamped on the `vellum-shared` channel;
 * its principal is the verified actor the route queued it for. Work a
 * contact's turn started (a subagent's or ACP session's completion) carries
 * that contact's trust instead of an author, and is theirs too. A contact
 * message missing its principal answers the empty string, which the check
 * refuses.
 */
function sharedSenderPrincipal(queued: QueuedMessage): string | undefined {
  if (queued.author?.sourceChannel === "vellum-shared") {
    return queued.sourceActorPrincipalId ?? "";
  }
  if (queued.trustContext?.sourceChannel === "vellum-shared") {
    return queued.trustContext.requesterExternalUserId ?? "";
  }
  return undefined;
}

/**
 * Announce that a queued message will never run: the terminal
 * `message_queued_deleted` its queued ack owes. When a shared-conversation
 * contact sent it, the sender is noted first so their own event stream
 * forwards the close-out and their optimistic row ends too. A message that
 * got no queued ack gets nothing. Every path that discards a queued message
 * announces it here.
 */
export function announceQueuedMessageDeleted(
  conversationId: string,
  queued: QueuedMessage,
): void {
  if (isSuppressedQueuedMessage(queued.metadata)) {
    return;
  }
  const principalId = sharedSenderPrincipal(queued);
  if (principalId !== undefined) {
    noteDroppedOwnMessage({
      requestId: queued.requestId,
      principalId,
      conversationId,
    });
  }
  queued.onEvent({
    type: "message_queued_deleted",
    conversationId,
    requestId: queued.requestId,
    ...(queued.clientMessageId
      ? { clientMessageId: queued.clientMessageId }
      : {}),
  });
}

/**
 * Close out a shared-conversation contact's queued message that failed to
 * persist. Other senders learn of that failure from its `error` event, which
 * a contact's stream does not carry, so this does nothing for them.
 */
export function closeOutSharedSenderMessage(
  conversationId: string,
  queued: QueuedMessage,
): void {
  if (sharedSenderPrincipal(queued) !== undefined) {
    announceQueuedMessageDeleted(conversationId, queued);
  }
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
      "Dropped a queued message: its sender could not be verified before it expired",
    );
  }
  announceQueuedMessageDeleted(conversation.conversationId, queued);
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
      // A contact's turn left the conversation scoped to them. The next
      // message from anyone else takes its own sender's scope back before it
      // runs, so it never runs on the contact's narrower history. A message
      // no turn started runs as the conversation did before the contact's
      // turn. While a turn is running it is left alone: the drain requeues it
      // behind that turn.
      if (conversation.trustContext?.sourceChannel === "vellum-shared") {
        if (next.trustContext) {
          await scopeHistoryToActor(conversation, next.trustContext);
        } else if (!conversation.isProcessing()) {
          await restoreActorBeforeContact(conversation);
        }
        if (conversation.queue.findByRequestId(next.requestId) !== next) {
          continue;
        }
      }
      conversation.queue.promoteToHead(next.requestId);
      return true;
    }

    let admission: SharedSenderAdmission;
    try {
      const { checkSharedSender } =
        await import("../runtime/shared-sender-admission.js");
      admission = await checkSharedSender(
        conversation.conversationId,
        principalId,
      );
    } catch (err) {
      log.warn(
        { err, conversationId: conversation.conversationId, principalId },
        "Shared sender admission check failed",
      );
      admission = { outcome: "unverifiable" };
    }
    const { outcome } = admission;
    // The check awaited; a message removed meanwhile is not ours to settle.
    if (conversation.queue.findByRequestId(next.requestId) !== next) {
      continue;
    }

    if (admission.outcome === "admitted") {
      unverifiable.delete(next);
      // The turn runs as the contact is now, not as they were when the
      // message was queued: their contact record, policy and routing
      // identity can all have changed while it waited. Every queued message
      // of theirs takes the same answer, so a batch of them still runs as
      // one sender.
      const isInteractive = resolveRoutingState(
        admission.trust,
      ).promptWaitingAllowed;
      for (const queued of conversation.queue.snapshot()) {
        if (sharedSenderPrincipal(queued) !== principalId) {
          continue;
        }
        queued.trustContext = admission.trust;
        // Work their turn started stays machine-authored and
        // non-interactive; only their own messages take both.
        if (queued.author) {
          queued.author = admission.trust;
          queued.isInteractive = isInteractive;
        }
      }
      // The turn runs on history scoped for the contact, exactly as a direct
      // send does, so nothing only the guardian may see reaches the loop.
      await scopeHistoryToActor(conversation, admission.trust);
      if (conversation.queue.findByRequestId(next.requestId) !== next) {
        continue;
      }
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
    if (now - state.firstAt >= maxUnverifiableAgeMs) {
      drop(conversation, next, principalId, "unverifiable");
      continue;
    }
    waiting.add(principalId);
    scheduleRetry(conversation, state.attempts);
  }
}

/**
 * Test-only: replace the retry backoff and the age an unverifiable message
 * is dropped at, or restore both with no argument.
 */
export function __setSharedSenderRetryForTest(overrides?: {
  delayMs?: (attempt: number) => number;
  maxAgeMs?: number;
}): void {
  retryDelayMs = overrides?.delayMs ?? defaultRetryDelayMs;
  maxUnverifiableAgeMs = overrides?.maxAgeMs ?? DEFAULT_MAX_UNVERIFIABLE_AGE_MS;
}
