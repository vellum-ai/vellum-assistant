/**
 * Access request decision handler: processes guardian decisions on
 * `ingress_access_request` approvals. Unlike escalated ingress messages,
 * access requests don't have a pending interaction in the session tracker,
 * so they need a separate decision path that creates a verification session
 * instead of resuming an agent loop.
 */
import {
  type GuardianApprovalRequest,
  resolveApprovalRequest,
} from "../../memory/guardian-approvals.js";
import { getLogger } from "../../util/logger.js";
import { createOutboundSession } from "../channel-verification-service.js";
import { deliverChannelReply } from "../gateway-client.js";

const log = getLogger("access-request-decision");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type AccessRequestDecisionAction = "approve" | "deny";

export type DeliveryResult = { ok: true } | { ok: false; reason: string };

export interface AccessRequestDecisionResult {
  handled: boolean;
  type: "approved" | "denied" | "stale" | "idempotent";
  verificationSessionId?: string;
  verificationCode?: string;
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

/**
 * Handle a guardian decision on an `ingress_access_request` approval.
 *
 * On approve: creates an identity-bound verification session with a 6-digit
 * code and returns it. The caller is responsible for delivering the code to
 * the guardian and notifying the requester.
 *
 * On deny: marks the approval as denied and returns. The caller is responsible
 * for notifying the requester.
 *
 * Returns `{ handled: false }` for non-access-request approvals so the caller
 * can fall through to the standard decision path.
 */
export function handleAccessRequestDecision(
  approval: GuardianApprovalRequest,
  action: AccessRequestDecisionAction,
  decidedByExternalUserId: string,
): AccessRequestDecisionResult {
  // Resolve the approval atomically. resolveApprovalRequest is idempotent:
  // if already resolved with the same decision, returns the existing record
  // unchanged. Returns null when already resolved with a *different* decision
  // or when the record doesn't exist.
  const decision = action === "approve" ? "approved" : "denied";
  const resolved = resolveApprovalRequest(
    approval.id,
    decision,
    decidedByExternalUserId,
  );

  if (!resolved) {
    // Already resolved with a different decision, or does not exist
    return { handled: true, type: "stale" };
  }

  // resolveApprovalRequest returns the existing record (unchanged) when the
  // approval was already resolved with the same decision. In that case
  // the approval's status was not 'pending' before our call. We detect
  // this by checking if the original approval (passed in) was already
  // non-pending, meaning the transition happened in a prior call.
  if (approval.status !== "pending") {
    return { handled: true, type: "idempotent" };
  }

  if (action === "deny") {
    return { handled: true, type: "denied" };
  }

  // On approve: create an identity-bound outbound verification session.
  // The session is bound to the requester's identity on the same channel
  // so only the original requester can consume the code. Mark as
  // trusted_contact so the consume path skips guardian binding creation.
  const session = createOutboundSession({
    channel: approval.channel,
    expectedExternalUserId: approval.requesterExternalUserId,
    expectedChatId: approval.requesterChatId,
    identityBindingStatus: "bound",
    destinationAddress: approval.requesterChatId,
    verificationPurpose: "trusted_contact",
  });

  return {
    handled: true,
    type: "approved",
    verificationSessionId: session.sessionId,
    verificationCode: session.secret,
  };
}

/**
 * Deliver the verification code to the guardian after an access request
 * approval. The guardian gives the code to the requester out-of-band.
 */
export async function deliverVerificationCodeToGuardian(params: {
  replyCallbackUrl: string;
  guardianChatId: string;
  requesterIdentifier: string;
  verificationCode: string;
  assistantId: string;
}): Promise<DeliveryResult> {
  const text =
    `You approved access for ${params.requesterIdentifier}. ` +
    `Give them this verification code: \`${params.verificationCode}\`. ` +
    `The code expires in 10 minutes.`;

  try {
    await deliverChannelReply(params.replyCallbackUrl, {
      chatId: params.guardianChatId,
      text,
      assistantId: params.assistantId,
    });
    return { ok: true };
  } catch (err) {
    log.error(
      { err, guardianChatId: params.guardianChatId },
      "Failed to deliver verification code to guardian",
    );
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}

/**
 * Resolve the delivery target for requester notifications. On Slack,
 * posting to a user ID (rather than the originating channel) delivers
 * the message as a DM, which is less disruptive than replying in a
 * shared channel. When routing to a DM, the `threadTs` query param is
 * stripped from the callback URL because it belongs to the guardian's
 * channel thread and would cause `thread_not_found` errors in the DM.
 */
function resolveRequesterTarget(params: {
  channel?: string;
  replyCallbackUrl: string;
  requesterChatId: string;
  requesterExternalUserId?: string;
}): { chatId: string; callbackUrl: string } {
  if (params.channel === "slack" && params.requesterExternalUserId) {
    let callbackUrl = params.replyCallbackUrl;
    try {
      const url = new URL(params.replyCallbackUrl);
      url.searchParams.delete("threadTs");
      callbackUrl = url.toString();
    } catch {
      // Malformed URL — use as-is; the downstream fetch will handle the error.
    }
    return {
      chatId: params.requesterExternalUserId,
      callbackUrl,
    };
  }
  return {
    chatId: params.requesterChatId,
    callbackUrl: params.replyCallbackUrl,
  };
}

/**
 * Deliver the verification code directly to the requester's DM on Slack,
 * removing the need for the guardian to manually share it.
 */
export async function deliverVerificationCodeToRequester(params: {
  replyCallbackUrl: string;
  requesterChatId: string;
  verificationCode: string;
  assistantId: string;
  channel?: string;
  requesterExternalUserId?: string;
}): Promise<DeliveryResult> {
  const text =
    `Great news — your access request was approved! ` +
    `Your verification code is: \`${params.verificationCode}\`. ` +
    `Reply with it here to complete verification. The code expires in 10 minutes.`;

  const target = resolveRequesterTarget(params);

  try {
    await deliverChannelReply(target.callbackUrl, {
      chatId: target.chatId,
      text,
      assistantId: params.assistantId,
    });
    return { ok: true };
  } catch (err) {
    log.error(
      { err, requesterChatId: params.requesterChatId },
      "Failed to deliver verification code to requester",
    );
    const reason = err instanceof Error ? err.message : String(err);
    return { ok: false, reason };
  }
}

/**
 * Notify the requester that the guardian has approved their access request
 * and they should enter the verification code they receive from the guardian.
 */
export async function notifyRequesterOfApproval(params: {
  replyCallbackUrl: string;
  requesterChatId: string;
  assistantId: string;
  channel?: string;
  requesterExternalUserId?: string;
}): Promise<void> {
  const text =
    "Your access request has been approved! " +
    "Please enter the 6-digit verification code you receive from the guardian.";

  const target = resolveRequesterTarget(params);

  try {
    await deliverChannelReply(target.callbackUrl, {
      chatId: target.chatId,
      text,
      assistantId: params.assistantId,
    });
  } catch (err) {
    log.error(
      { err, requesterChatId: params.requesterChatId },
      "Failed to notify requester of access request approval",
    );
  }
}

/**
 * Notify the requester that something went wrong delivering the verification
 * code and they should try again later. Sent instead of the "enter the code"
 * message when guardian code delivery fails.
 */
export async function notifyRequesterOfDeliveryFailure(params: {
  replyCallbackUrl: string;
  requesterChatId: string;
  assistantId: string;
  channel?: string;
  requesterExternalUserId?: string;
}): Promise<void> {
  const text =
    "Your access request was approved, but we were unable to " +
    "deliver the verification code. Please try again later.";

  const target = resolveRequesterTarget(params);

  try {
    await deliverChannelReply(target.callbackUrl, {
      chatId: target.chatId,
      text,
      assistantId: params.assistantId,
    });
  } catch (err) {
    log.error(
      { err, requesterChatId: params.requesterChatId },
      "Failed to notify requester of delivery failure",
    );
  }
}

/**
 * Notify the requester that the guardian has denied their access request.
 */
export async function notifyRequesterOfDenial(params: {
  replyCallbackUrl: string;
  requesterChatId: string;
  assistantId: string;
  channel?: string;
  requesterExternalUserId?: string;
}): Promise<void> {
  const text = "Your access request has been denied by the guardian.";

  const target = resolveRequesterTarget(params);

  try {
    await deliverChannelReply(target.callbackUrl, {
      chatId: target.chatId,
      text,
      assistantId: params.assistantId,
    });
  } catch (err) {
    log.error(
      { err, requesterChatId: params.requesterChatId },
      "Failed to notify requester of access request denial",
    );
  }
}
