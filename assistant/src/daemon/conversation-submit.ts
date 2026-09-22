/**
 * One entry point for a user's send, shared by every ingress that carries one.
 *
 * A send arrives against a conversation in one of three states, and the answer
 * is the same wherever it came from: run it now, stop the turn in flight and
 * run it in that turn's place, or wait for the conversation to free up and run
 * it then. The HTTP send route, the CLI signal and a surface action click all
 * route through here so the decision lives once rather than three times.
 *
 * The caller supplies `run`, everything the send does once the conversation is
 * free: the interaction sweep, slash resolution, the user-row persist and the
 * turn dispatch. Keeping that with the caller is what lets the three ingress
 * paths keep their own dispatch shapes while sharing the decision.
 */

import type { AssistantEvent } from "../api/index.js";
import { getLogger } from "../util/logger.js";
import type { Conversation } from "./conversation.js";
import {
  AdmissionOverflowError,
  canDeferSend,
  pendingAdmissionCount,
  runWhenConversationIdle,
} from "./conversation-admission.js";
import { isConversationBusyError } from "./conversation-busy-error.js";
import {
  classifyInterruptEligibility,
  interruptRunningTurn,
} from "./conversation-interrupt.js";
import { repairInterruptedToolUseBlocks } from "./conversation-interrupt-repair.js";

const log = getLogger("conversation-submit");

/**
 * What {@link submitUserTurn} did with the send.
 *
 * - `started`: the conversation was free and `run` has already finished.
 * - `interrupting`: the running turn is being stopped and `run` follows, off
 *   the caller's response. A caller that answers a request answers it now.
 * - `deferred`: `run` is registered to happen when the conversation frees up.
 */
export type SubmitOutcome = "started" | "interrupting" | "deferred";

export interface SubmitUserTurnOptions {
  /** Verified identity of the caller sending the message. */
  callerActorPrincipalId?: string;
  /** A hidden machine signal rather than a person's own send. */
  hidden?: boolean;
  /** Names the calling site in logs and in the abort reason. */
  origin: string;
  /** The sender's event sink, told when the send could not be delivered. */
  onEvent: (msg: AssistantEvent) => void;
  /** Correlation id the sender already holds for this send. */
  requestId: string;
  /**
   * Everything the send does once the conversation is free to take it. Takes
   * the conversation's processing lock itself, and may reject with the
   * processing-lock error when it loses that lock to another claimant.
   */
  run: () => Promise<void>;
  /**
   * Called once every piece of work this submit owns has settled, including
   * work that ran off the caller's response. Callers release per-send
   * reservations here.
   */
  onSettled?: () => void;
}

/**
 * Decide what a user's send does to the conversation it is addressed to, and
 * see it through.
 *
 * An idle conversation runs the send inline, so a caller that answers a
 * request answers it with whatever `run` produced. A busy one is answered
 * before the outcome is known: the handover is bounded by the abort budget
 * plus the turn-boundary commit wait, far longer than a send may hold a
 * request open, so `interrupting` comes back the moment the decision is made
 * and the rest happens off the response.
 *
 * Every path that does not run now ends at {@link runWhenConversationIdle}: an
 * interrupt that could not hand over, a send that may not interrupt, and a
 * send that lost the processing lock to another claimant all wait there rather
 * than being refused. There is no other holding place for a message.
 *
 * Rejects with {@link AdmissionOverflowError} when the conversation's deferral
 * chain is full and the send has not been accepted yet, so a caller answering
 * a request can refuse it in that answer. Past acceptance the same overflow
 * reaches the sender as a `SEND_FAILED` event instead.
 */
export async function submitUserTurn(
  conversation: Conversation,
  options: SubmitUserTurnOptions,
): Promise<SubmitOutcome> {
  const { conversationId } = conversation;
  const settle = (): void => {
    options.onSettled?.();
  };

  if (!conversation.isProcessing()) {
    try {
      await options.run();
      settle();
      return "started";
    } catch (err) {
      if (!isConversationBusyError(err)) {
        settle();
        throw err;
      }
      // Another claimant took the lock inside `run`'s own awaits. The send is
      // not refused for losing that race: it waits for idle like any other.
      log.info(
        { conversationId, origin: options.origin },
        "Send lost the processing lock while starting its turn; deferring it",
      );
    }
    assertDeferralCapacity(conversationId, settle);
    deferDetached(conversation, options, settle);
    return "deferred";
  }

  const interruptOptions = {
    callerActorPrincipalId: options.callerActorPrincipalId,
    hidden: options.hidden === true,
    origin: options.origin,
  };
  // Classified synchronously so the caller can commit to an answer before any
  // of the handover is awaited.
  if (
    classifyInterruptEligibility(conversation, interruptOptions) !== "eligible"
  ) {
    assertDeferralCapacity(conversationId, settle);
    deferDetached(conversation, options, settle);
    return "deferred";
  }

  void (async () => {
    const outcome = await interruptRunningTurn(conversation, interruptOptions);
    if (outcome !== "released") {
      await deferAfterAcceptance(conversation, options, `interrupt_${outcome}`);
      return;
    }
    try {
      await options.run();
    } catch (err) {
      if (!isConversationBusyError(err)) {
        throw err;
      }
      await deferAfterAcceptance(conversation, options, "lock_race");
    }
  })()
    .catch((err) => {
      log.error(
        { err, conversationId, requestId: options.requestId },
        "Interrupting send failed after acceptance",
      );
      reportSendFailed(conversationId, options);
    })
    .finally(settle);

  return "interrupting";
}

/**
 * Register `run` to happen once the conversation frees up, without anything
 * left to await it.
 *
 * Fire-and-forget by construction: the caller has either already answered its
 * request or is about to, so a failure has to reach the sender as an event.
 */
function deferDetached(
  conversation: Conversation,
  options: SubmitUserTurnOptions,
  settle: () => void,
): void {
  void runDeferred(conversation, options)
    .catch((err) => {
      log.error(
        {
          err,
          conversationId: conversation.conversationId,
          requestId: options.requestId,
          origin: options.origin,
        },
        "Deferred send failed",
      );
      reportSendFailed(conversation.conversationId, options);
    })
    .finally(settle);
}

/** The deferral an interrupt falls back to once its request is answered. */
async function deferAfterAcceptance(
  conversation: Conversation,
  options: SubmitUserTurnOptions,
  reason: string,
): Promise<void> {
  try {
    await runDeferred(conversation, options);
  } catch (err) {
    log.error(
      {
        err,
        conversationId: conversation.conversationId,
        requestId: options.requestId,
        reason,
      },
      "Deferred send for an accepted message failed",
    );
    reportSendFailed(conversation.conversationId, options);
  }
}

/**
 * Wait for the conversation, repair the history a stopped turn left, then run
 * the send.
 *
 * The repair runs at the head of every deferred send rather than only after an
 * interrupt, because the interrupt's own repair is one of the reasons a send
 * lands here: it answers `busy` precisely when it cannot make that repair
 * durable. A conversation with nothing dangling gets a no-op, and one whose
 * repair still cannot be persisted fails the send instead of writing a user
 * row after a `tool_use` with no result.
 */
async function runDeferred(
  conversation: Conversation,
  options: SubmitUserTurnOptions,
): Promise<void> {
  // No `onEvent`: admission reports a spent retry budget on the sink it is
  // given, and this path already reports every failure itself. Passing one
  // would tell the sender the send failed twice.
  await runWhenConversationIdle(
    conversation.conversationId,
    async () => {
      await repairInterruptedToolUseBlocks(conversation, {
        requireDurable: true,
      });
      await options.run();
    },
    { origin: options.origin },
  );
}

/**
 * Refuse a send before it is accepted when the conversation's deferral chain
 * is full.
 *
 * Read immediately before registering, which is what makes it authoritative:
 * registration is synchronous, so nothing else can take the last slot in
 * between.
 */
function assertDeferralCapacity(
  conversationId: string,
  settle: () => void,
): void {
  if (canDeferSend(conversationId)) {
    return;
  }
  settle();
  throw new AdmissionOverflowError(
    conversationId,
    pendingAdmissionCount(conversationId),
  );
}

function reportSendFailed(
  conversationId: string,
  options: SubmitUserTurnOptions,
): void {
  options.onEvent({
    type: "error",
    conversationId,
    requestId: options.requestId,
    code: "SEND_FAILED",
    message: "Your message could not be delivered. Please send it again.",
    errorCategory: "internal",
  });
}
