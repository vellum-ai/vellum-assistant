/**
 * Interrupt the turn a conversation is running so a message that just arrived
 * can be delivered at once.
 *
 * Gated on `interrupt-on-send`. Off, a message sent while the assistant is
 * busy goes on the conversation's queue and runs when the current turn ends;
 * on, it stops the turn in flight and takes its place.
 *
 * The helper covers everything between "a message arrived for a busy
 * conversation" and "the conversation is idle and the ordinary send path can
 * run". Both ingress paths (the HTTP send route and the CLI signal) call it
 * and, on `"released"`, fall through to the code they already use for an idle
 * conversation, so there is one turn-dispatch implementation rather than a
 * third one for interrupts.
 */

import { isInterruptOnSendEnabled } from "../config/interrupt-on-send-gate.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import { ABORT_RELEASE_WAIT_MS } from "./abort-watchdog.js";
import type { Conversation } from "./conversation.js";
import { repairInterruptedToolUseBlocks } from "./conversation-interrupt-repair.js";
import { denyPendingConfirmationsOnSupersession } from "./handlers/conversations.js";

const log = getLogger("conversation-interrupt");

/**
 * What an interrupt attempt settled on.
 *
 * - `released`: the running turn is over and the conversation is idle. The
 *   caller starts the new message's turn on the ordinary idle path.
 * - `declined`: this send must not interrupt (the flag is off, the send is a
 *   hidden machine signal, or the sender is not the actor running the turn).
 *   The caller queues it, which is what the flag-off path does with every
 *   send.
 * - `busy`: the conversation cannot be handed over. Either the lock is held by
 *   something that is not an abortable turn, or the interrupted turn never let
 *   go of it inside the abort budget, or its history repair could not be
 *   persisted. The caller queues the message so it still runs, rather than
 *   racing a live holder or writing a user row onto a broken history.
 */
export type InterruptOutcome = "released" | "declined" | "busy";

/**
 * Whether this sender may interrupt the turn that is running.
 *
 * Same rule the queue's `mayActOnQueuedMessage` applies to cancelling and
 * steering another actor's queued message, read against the running turn's
 * requester instead: the actor whose turn it is may cut it short, and so may a
 * caller with no actor principal, who is the guardian by the convention the
 * routes layer follows (local/IPC and service principals carry none). Any
 * other actor's message queues, because stopping a turn somebody else is
 * watching is not theirs to do.
 */
export function mayInterruptRunningTurn(
  conversation: Conversation,
  callerActorPrincipalId: string | undefined,
): boolean {
  const turnActorPrincipalId = conversation.currentTurnSourceActorPrincipalId;
  if (!turnActorPrincipalId || !callerActorPrincipalId) {
    return true;
  }
  return turnActorPrincipalId === callerActorPrincipalId;
}

export interface InterruptOptions {
  /** Verified identity of the caller sending the interrupting message. */
  callerActorPrincipalId?: string;
  /**
   * A hidden send is a machine signal rather than a user decision. It is not
   * eligible to interrupt: see the check in {@link interruptRunningTurn}.
   */
  hidden?: boolean;
  /** Names the calling site in logs and in the abort reason. */
  origin: string;
}

/**
 * Stop the running turn and leave the conversation ready for the new message.
 *
 * Only an abortable agent turn is interruptible. Every other hold on the
 * processing flag answers `busy`, and the message queues behind it.
 *
 * Sequence, and why it is this order:
 *
 *  1. Supersede the interactions the running turn parked (confirmations are
 *     denied, and an open `ask_question` is settled by the abort below), so
 *     the turn unwinds immediately instead of sitting on a prompt nobody is
 *     going to answer.
 *  2. Abort the turn with `preempted_by_new_message`, straight at the
 *     controller rather than through `abortConversation`: that path treats a
 *     non-interrupt abort as a teardown and discards the queue, and the queue
 *     may still hold another actor's messages that this send has no business
 *     dropping. Background subagents keep running for the same reason a steer
 *     leaves them alone: the new turn's model decides what to do about them.
 *  3. Wait for the turn's own `finally` to release the processing lock, under
 *     the abort watchdog's budget.
 *  4. Repair the history: every `tool_use` the abort abandoned gets a
 *     synthetic `tool_result`, persisted, BEFORE the caller writes the new
 *     user row. A user message between a `tool_use` and its result is a
 *     sequence every provider rejects, so the order is load-bearing, and a
 *     repair that cannot be made durable answers `busy` rather than letting
 *     the caller write that row over a broken durable history.
 */
export async function interruptRunningTurn(
  conversation: Conversation,
  options: InterruptOptions,
): Promise<InterruptOutcome> {
  if (!isInterruptOnSendEnabled()) {
    return "declined";
  }
  if (!conversation.isProcessing()) {
    return "released";
  }
  if (options.hidden === true) {
    // A hidden send is a machine signal (proactive-greeting priming, the
    // channel-setup wizard close), not a user deciding to move on, which is
    // the whole justification for ending a turn somebody is watching. It is
    // also exempt from the confirmation sweep an interrupt has to run to get
    // the lock released, so it takes the queue instead, exactly as it does
    // with the flag off.
    return "declined";
  }
  if (!mayInterruptRunningTurn(conversation, options.callerActorPrincipalId)) {
    log.info(
      {
        conversationId: conversation.conversationId,
        origin: options.origin,
        callerActorPrincipalId: options.callerActorPrincipalId,
      },
      "Refusing to interrupt a turn started by a different actor principal; queueing instead",
    );
    return "declined";
  }
  if (!conversation.abortController) {
    // The processing flag is held by something that is not an abortable agent
    // turn: a `/compact` or `/clean` fence, another `acquireProcessingFenced`
    // holder, or a turn that already tore its controller down. Nothing here
    // can tell a live holder from an orphaned latch, and force-clearing a live
    // one would start a turn that rewrites the history its holder is still
    // persisting. So it stays busy, and the message queues behind it.
    log.info(
      { conversationId: conversation.conversationId, origin: options.origin },
      "Processing is held with no abortable turn behind it; queueing the message instead of interrupting",
    );
    return "busy";
  }

  log.info(
    { conversationId: conversation.conversationId, origin: options.origin },
    "Interrupting the running turn for a newly arrived user message",
  );

  try {
    denyPendingConfirmationsOnSupersession(conversation.conversationId);
  } catch (err) {
    log.warn(
      { err, conversationId: conversation.conversationId },
      "Pre-interrupt interaction supersession failed; the abort below still settles the turn",
    );
  }

  conversation.abortController.abort(
    createAbortReason(
      "preempted_by_new_message",
      options.origin,
      conversation.conversationId,
    ),
  );
  // Deny pending confirmations so the abort unblocks immediately, the same
  // way a steer does.
  conversation.denyAllPendingConfirmations();

  const released = await conversation.waitForIdle({
    timeoutMs: ABORT_RELEASE_WAIT_MS,
  });
  if (!released) {
    log.warn(
      { conversationId: conversation.conversationId, origin: options.origin },
      "Interrupted turn did not release the processing lock within the abort budget; queueing the message instead",
    );
    return "busy";
  }

  try {
    await repairInterruptedToolUseBlocks(conversation, {
      force: true,
      requireDurable: true,
    });
  } catch (err) {
    // The repair row is not durable, so the caller must not write the
    // interrupting user row after it. Queue the message instead: it runs on
    // the next drain, against an unchanged history.
    log.warn(
      { err, conversationId: conversation.conversationId },
      "Could not persist the interrupt's tool_result repair; queueing the message instead",
    );
    return "busy";
  }

  // The interrupted turn's `generation_cancelled` tells clients the old turn is
  // over, which idles their turn state. This says the conversation is working
  // again, so the composer's indicator picks straight back up on the new
  // turn: the same job `message_dequeued` does at the head of a drained turn.
  conversation.emitActivityState("thinking", "message_interrupted");

  return "released";
}
