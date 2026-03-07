/**
 * Guardian action follow-up executor.
 *
 * After the conversation engine classifies the guardian's reply as
 * `call_back` and transitions the follow-up state to `dispatching`,
 * this module executes the actual action:
 *
 *   - **call_back**: Starts an outbound call to the counterparty with
 *     context about the guardian's answer.
 *
 * The executor resolves the counterparty from the original call session,
 * dispatches the appropriate action, and returns a result with generated
 * reply text for the guardian's confirmation message.
 *
 * This module is channel-agnostic: both inbound-message-handler (Telegram
 * channels) and session-process (mac/IPC channel) use it.
 */

import { startCall } from "../calls/call-domain.js";
import { getCallSession } from "../calls/call-store.js";
import { getOrCreateConversation } from "../memory/conversation-key-store.js";
import {
  finalizeFollowup,
  type FollowupAction,
  getGuardianActionRequest,
  type GuardianActionRequest,
} from "../memory/guardian-action-store.js";
import { getLogger } from "../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "./assistant-scope.js";
import { composeGuardianActionMessageGenerative } from "./guardian-action-message-composer.js";
import type { GuardianActionCopyGenerator } from "./http-types.js";

const log = getLogger("guardian-action-followup-executor");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface CounterpartyInfo {
  phoneNumber: string;
  /** Human-readable identifier (phone number or name if available). */
  displayIdentifier: string;
}

export type FollowupExecutionResult =
  | { ok: true; action: FollowupAction; guardianReplyText: string }
  | {
      ok: false;
      action: FollowupAction;
      guardianReplyText: string;
      error: string;
    };

// ---------------------------------------------------------------------------
// Counterparty resolution
// ---------------------------------------------------------------------------

/**
 * Resolve the counterparty (the external person) from the original call
 * session by call direction.
 *
 * - **Inbound calls** (`initiatedFromConversationId` is null): the external
 *   caller is `fromNumber`, the assistant's Twilio number is `toNumber`.
 * - **Outbound calls** (`initiatedFromConversationId` is set): the assistant
 *   placed the call so `fromNumber` is the assistant's number and `toNumber`
 *   is the external callee.
 */
export function resolveCounterparty(
  callSessionId: string,
): CounterpartyInfo | null {
  const session = getCallSession(callSessionId);
  if (!session) {
    log.warn(
      { callSessionId },
      "Cannot resolve counterparty: call session not found",
    );
    return null;
  }

  // Outbound calls (startCall) store the assistant's number in fromNumber
  // and the callee in toNumber. They always have initiatedFromConversationId.
  const isOutbound = !!session.initiatedFromConversationId;
  const phoneNumber = isOutbound ? session.toNumber : session.fromNumber;

  if (!phoneNumber) {
    log.warn(
      { callSessionId, isOutbound },
      "Cannot resolve counterparty: no phone number on call session",
    );
    return null;
  }

  return {
    phoneNumber,
    displayIdentifier: phoneNumber,
  };
}

// ---------------------------------------------------------------------------
// Action dispatchers
// ---------------------------------------------------------------------------

/**
 * Start an outbound call to the counterparty with context about the
 * guardian's answer. Uses the existing call start domain flow.
 */
async function executeCallBack(
  request: GuardianActionRequest,
  counterparty: CounterpartyInfo,
): Promise<{ ok: true } | { ok: false; error: string }> {
  try {
    const task = request.lateAnswerText
      ? `Call back regarding a question that was asked earlier: "${request.questionText}". The guardian has provided an answer: "${request.lateAnswerText}". Relay this answer to the person.`
      : `Call back regarding a question that was asked earlier: "${request.questionText}". The guardian wants to follow up with them.`;

    const callbackContext = [
      `This is a follow-up callback. The person called earlier and asked: "${request.questionText}".`,
      request.lateAnswerText
        ? `The guardian's answer is: "${request.lateAnswerText}".`
        : null,
      "Relay this information naturally and ask if they need anything else.",
    ]
      .filter(Boolean)
      .join(" ");

    // Create a conversation for the callback call
    const convKey = `followup-callback:${request.id}`;
    const { conversationId } = getOrCreateConversation(convKey);

    const result = await startCall({
      phoneNumber: counterparty.phoneNumber,
      task,
      context: callbackContext,
      conversationId,
      assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
    });

    if (!result.ok) {
      log.warn(
        { requestId: request.id, error: result.error },
        "Failed to start follow-up callback call",
      );
      return { ok: false, error: result.error };
    }

    log.info(
      {
        requestId: request.id,
        callSessionId: result.session.id,
        counterpartyPhone: counterparty.phoneNumber,
      },
      "Follow-up call_back initiated successfully",
    );

    return { ok: true };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.error(
      {
        err,
        requestId: request.id,
        counterpartyPhone: counterparty.phoneNumber,
      },
      "Failed to start follow-up callback call",
    );
    return { ok: false, error: message };
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Execute a follow-up action after the conversation engine has classified
 * the guardian's intent as call_back or message_back and the follow-up
 * state has been transitioned to `dispatching`.
 *
 * On success: finalizes the follow-up to `completed` and returns
 * generated confirmation text for the guardian.
 *
 * On failure: finalizes the follow-up to `failed` and returns
 * generated error text for the guardian.
 */
export async function executeFollowupAction(
  requestId: string,
  action: FollowupAction,
  generator?: GuardianActionCopyGenerator,
): Promise<FollowupExecutionResult> {
  const request = getGuardianActionRequest(requestId);
  if (!request) {
    const errorText = await composeGuardianActionMessageGenerative(
      {
        scenario: "followup_action_failed",
        failureReason: "The follow-up request could not be found.",
      },
      {},
      generator,
    );
    return {
      ok: false,
      action,
      guardianReplyText: errorText,
      error: "Request not found",
    };
  }

  if (request.followupState !== "dispatching") {
    const errorText = await composeGuardianActionMessageGenerative(
      {
        scenario: "followup_action_failed",
        failureReason:
          "This follow-up is no longer in a valid state for execution.",
      },
      {},
      generator,
    );
    return {
      ok: false,
      action,
      guardianReplyText: errorText,
      error: `Invalid followup state: ${request.followupState}`,
    };
  }

  // Resolve the counterparty from the original call session
  const counterparty = resolveCounterparty(request.callSessionId);
  if (!counterparty) {
    finalizeFollowup(requestId, "failed");
    const errorText = await composeGuardianActionMessageGenerative(
      {
        scenario: "followup_action_failed",
        failureReason: "I couldn't find the caller's contact information.",
      },
      {},
      generator,
    );
    return {
      ok: false,
      action,
      guardianReplyText: errorText,
      error: "Counterparty not found",
    };
  }

  // Execute the action
  let actionResult: { ok: true } | { ok: false; error: string };

  if (action === "call_back") {
    actionResult = await executeCallBack(request, counterparty);
  } else {
    // decline is already handled in M5 — should not reach the executor.
    // message_back (SMS) is no longer supported.
    finalizeFollowup(requestId, "failed");
    const errorText = await composeGuardianActionMessageGenerative(
      {
        scenario: "followup_action_failed",
        failureReason: "An unexpected action was requested.",
      },
      {},
      generator,
    );
    return {
      ok: false,
      action,
      guardianReplyText: errorText,
      error: `Unsupported action: ${action}`,
    };
  }

  if (actionResult.ok) {
    finalizeFollowup(requestId, "completed");

    const scenario = "followup_call_started" as const;
    const confirmText = await composeGuardianActionMessageGenerative(
      {
        scenario,
        counterpartyPhone: counterparty.phoneNumber,
        questionText: request.questionText,
        lateAnswerText: request.lateAnswerText ?? undefined,
      },
      {},
      generator,
    );

    return { ok: true, action, guardianReplyText: confirmText };
  }

  // Action failed
  finalizeFollowup(requestId, "failed");
  const errorText = await composeGuardianActionMessageGenerative(
    {
      scenario: "followup_action_failed",
      failureReason: actionResult.error,
      counterpartyPhone: counterparty.phoneNumber,
    },
    {},
    generator,
  );

  return {
    ok: false,
    action,
    guardianReplyText: errorText,
    error: actionResult.error,
  };
}
