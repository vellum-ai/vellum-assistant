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
import { getConfigReadOnly } from "../config/loader.js";
import { supersedePendingSecrets } from "../runtime/pending-interactions.js";
import { createAbortReason } from "../util/abort-reasons.js";
import { getLogger } from "../util/logger.js";
import {
  ABORT_RELEASE_WAIT_MS,
  resolveTurnCommitWaitMs,
} from "./abort-watchdog.js";
import type { Conversation } from "./conversation.js";
import { repairInterruptedToolUseBlocks } from "./conversation-interrupt-repair.js";
import { denyPendingConfirmationsOnSupersession } from "./handlers/conversations.js";
import { waitForTurnFinalization } from "./turn-finalization.js";

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
 * - `busy`: the conversation cannot be handed over. The lock is held by
 *   something that is not an abortable turn, or the interrupted turn never let
 *   go of it inside the abort budget, or another waiter took it as that turn
 *   released, or the history repair could not be persisted. The caller queues
 *   the message so it still runs, rather than racing a live holder or writing
 *   a user row onto a broken history.
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
 *     denied, secret prompts are settled by name, and an open `ask_question`
 *     is settled by the abort below), so the turn unwinds immediately instead
 *     of sitting on a prompt nobody is going to answer.
 *  2. Abort the turn with `preempted_by_new_message`, straight at the
 *     controller rather than through `abortConversation`: that path treats a
 *     non-interrupt abort as a teardown and discards the queue, and the queue
 *     may still hold another actor's messages that this send has no business
 *     dropping. Background subagents keep running for the same reason a steer
 *     leaves them alone: the new turn's model decides what to do about them.
 *  3. Wait for the turn's own `finally` to release the processing lock, under
 *     the abort watchdog's budget, and then for the finalization barrier that
 *     covers the turn-boundary commit, which runs after that release and would
 *     otherwise sweep the replacement turn's first file writes into the
 *     finished turn's commit. Then claim the lock for the repair. An idle
 *     transition is not the same as a free lock: a waiter registered earlier
 *     can take it on the same transition, and the claim is what says this path
 *     holds it rather than merely saw it change hands.
 *  4. Repair the history: every `tool_use` the abort abandoned gets a
 *     synthetic `tool_result`, persisted, BEFORE the caller writes the new
 *     user row. A user message between a `tool_use` and its result is a
 *     sequence every provider rejects, so the order is load-bearing, and a
 *     repair that cannot be made durable answers `busy` rather than letting
 *     the caller write that row over a broken durable history.
 *  6. Arms the activity-state bridge the agent loop emits at the head of the
 *     replacement turn. Deferred rather than emitted here so a send that fails
 *     after the handover cannot strand every client on a cached busy state.
 */
/**
 * Why a send may or may not stop the turn a conversation is running.
 *
 * `eligible` is the only value that interrupts; every other value takes the
 * queue, exactly as the flag-off path does.
 */
export type InterruptEligibility =
  | "eligible"
  /** The `interrupt-on-send` flag is off for this install. */
  | "flag_off"
  /**
   * A hidden send is a machine signal (proactive-greeting priming, the
   * channel-setup wizard close), not a user deciding to move on, which is the
   * whole justification for ending a turn somebody is watching. It is also
   * exempt from the confirmation sweep an interrupt has to run to get the lock
   * released.
   */
  | "hidden"
  /** The turn belongs to a different actor principal. */
  | "other_actor"
  /**
   * The processing flag is held by something that is not an abortable agent
   * turn: a `/compact` or `/clean` fence, another `acquireProcessingFenced`
   * holder, or a turn that already tore its controller down. Nothing here can
   * tell a live holder from an orphaned latch, and force-clearing a live one
   * would start a turn that rewrites the history its holder is still
   * persisting.
   */
  | "no_abortable_turn";

/**
 * Decide whether this send may stop the running turn, synchronously, so a
 * caller can commit to the handover before any of it is awaited.
 *
 * {@link interruptRunningTurn} routes on the same answer rather than repeating
 * the checks, so the fast gate a route uses to accept a message and the slow
 * path that actually performs the handover can never disagree.
 *
 * Only meaningful for a conversation that is currently processing: an idle one
 * has no turn to interrupt, and its send takes the ordinary path.
 */
export function classifyInterruptEligibility(
  conversation: Conversation,
  options: InterruptOptions,
): InterruptEligibility {
  if (!isInterruptOnSendEnabled()) {
    return "flag_off";
  }
  if (options.hidden === true) {
    return "hidden";
  }
  if (!mayInterruptRunningTurn(conversation, options.callerActorPrincipalId)) {
    return "other_actor";
  }
  if (!conversation.abortController) {
    return "no_abortable_turn";
  }
  return "eligible";
}

export async function interruptRunningTurn(
  conversation: Conversation,
  options: InterruptOptions,
): Promise<InterruptOutcome> {
  if (!conversation.isProcessing()) {
    return "released";
  }
  const eligibility = classifyInterruptEligibility(conversation, options);
  if (eligibility === "other_actor") {
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
  if (eligibility === "no_abortable_turn") {
    log.info(
      { conversationId: conversation.conversationId, origin: options.origin },
      "Processing is held with no abortable turn behind it; queueing the message instead of interrupting",
    );
    // Not `declined`: the caller must not treat this as "the feature is off",
    // because the lock really is held and the message really must wait.
    return "busy";
  }
  if (eligibility !== "eligible") {
    return "declined";
  }
  // Captured rather than read again at the abort below: the turn can tear its
  // controller down between the classification and here, and a send that finds
  // nothing to abort must queue rather than proceed as if it had stopped one.
  const abortController = conversation.abortController;
  if (!abortController) {
    log.info(
      { conversationId: conversation.conversationId, origin: options.origin },
      "The running turn released its abort controller before the interrupt could use it; queueing the message instead",
    );
    return "busy";
  }

  log.info(
    { conversationId: conversation.conversationId, origin: options.origin },
    "Interrupting the running turn for a newly arrived user message",
  );

  try {
    denyPendingConfirmationsOnSupersession(conversation.conversationId);
    // Confirmations are settled by the sweep above and a parked
    // `ask_question` by the abort's own signal. A secret prompt is neither: it
    // is not a confirmation, so the sweep skips it whenever the turn parked no
    // confirmation, and it carries no abort listener. Left open, its dialog
    // stays live and a submission that lands after the new turn started
    // resolves the Promise the abandoned tool is parked on.
    supersedePendingSecrets(conversation.conversationId);
  } catch (err) {
    log.warn(
      { err, conversationId: conversation.conversationId },
      "Pre-interrupt interaction supersession failed; the abort below still settles the turn",
    );
  }

  abortController.abort(
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

  // The lock frees as soon as the turn's content settles, which is before its
  // turn-boundary commit runs. That commit attributes the working tree to the
  // turn that just ended, so a replacement turn that started writing files
  // while it was preparing would have those writes swept into the wrong
  // commit. The barrier closes once the commit is done. The queue drain gets
  // the same ordering from sitting inside the loop's own `finally`.
  const finalizationBudgetMs = resolveTurnCommitWaitMs(
    getConfigReadOnly().workspaceGit?.turnCommitMaxWaitMs,
  );
  const finalized = await waitForTurnFinalization(
    conversation.conversationId,
    finalizationBudgetMs,
  );
  if (!finalized) {
    log.warn(
      {
        conversationId: conversation.conversationId,
        origin: options.origin,
        finalizationBudgetMs,
      },
      "Interrupted turn is still finalizing after the commit budget; queueing the message instead",
    );
    return "busy";
  }

  // `waitForIdle` proves an idle transition happened, not that the lock is
  // free now. Idle waiters are notified FIFO off the same
  // `setProcessing(false)`, so one registered earlier (channel admission, an
  // agent wake) can take the lock before this continuation runs. Claim it
  // here rather than re-checking `isProcessing()`, because the repair below
  // both mutates the in-memory history and writes a row: a check would leave a
  // window between itself and those writes, and the claim does not. The whole
  // stretch from here to the release is this path's alone.
  let owner: number | null;
  try {
    owner = await conversation.acquireProcessingFenced();
  } catch (err) {
    log.warn(
      { err, conversationId: conversation.conversationId },
      "Could not claim the processing lock after the interrupt; queueing the message instead",
    );
    return "busy";
  }
  if (owner === null) {
    log.info(
      { conversationId: conversation.conversationId, origin: options.origin },
      "Another waiter took the processing lock as the interrupted turn released it; queueing the message instead",
    );
    return "busy";
  }

  let repaired = false;
  let preemptedToolResultOnTail = false;
  try {
    const repair = await repairInterruptedToolUseBlocks(conversation, {
      force: true,
      requireDurable: true,
    });
    preemptedToolResultOnTail = repair.preemptedToolResultOnTail;
    repaired = true;
  } catch (err) {
    // The repair row is not durable, so the caller must not write the
    // interrupting user row after it. Queue the message instead: it runs on
    // the next drain, against an unchanged history.
    log.warn(
      { err, conversationId: conversation.conversationId },
      "Could not persist the interrupt's tool_result repair; queueing the message instead",
    );
  } finally {
    // The caller takes its own claim for the turn it starts, and loses the
    // same race to a competing waiter the same way any idle send does: its
    // persist raises the busy error, which the send path answers by queueing.
    conversation.releaseProcessing(owner);
  }
  if (!repaired) {
    return "busy";
  }

  // Arm the `thinking` / `message_interrupted` transition that tells clients the
  // conversation is working again, so the composer's indicator picks straight
  // back up: the same job `message_dequeued` does at the head of a drained turn.
  // The agent loop emits it at the head of the replacement turn rather than
  // this path emitting it now, because the caller can still fail between here
  // and that turn, and an activity state is cached and replayed to reconnecting
  // clients. Emitted here, such a failure would leave every client showing a
  // busy conversation with nothing running and no path back to idle.
  conversation.pendingInterruptActivityBridge = true;

  // An abort that landed during the provider call answered no tool call, so
  // nothing in the history tells the model its turn was cut off. Arm the note
  // the interrupting user message carries instead. A tail that already holds a
  // preempted `tool_result` needs none: that result says the same thing, and
  // saying it twice in one prompt is noise.
  if (!preemptedToolResultOnTail) {
    conversation.pendingInterruptNote = true;
  }

  return "released";
}
