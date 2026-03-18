/**
 * Guardian callback decision strategy: handles inbound messages from a
 * guardian sender who has pending guardian approval requests. Routes through
 * callback buttons or the conversational engine.
 */
import { applyGuardianDecision } from "../../../approvals/guardian-decision-primitive.js";
import type { ChannelId } from "../../../channels/types.js";
import {
  getAllPendingApprovalsByGuardianChat,
  getPendingApprovalByRequestAndGuardianChat,
  type GuardianApprovalRequest,
} from "../../../memory/guardian-approvals.js";
import { emitNotificationSignal } from "../../../notifications/emit-signal.js";
import type { NotificationSourceChannel } from "../../../notifications/signal.js";
import { getLogger } from "../../../util/logger.js";
import { runApprovalConversationTurn } from "../../approval-conversation-turn.js";
import { composeApprovalMessageGenerative } from "../../approval-message-composer.js";
import type {
  ApprovalAction,
  ApprovalDecisionResult,
} from "../../channel-approval-types.js";
import { deliverChannelReply } from "../../gateway-client.js";
import type {
  ApprovalConversationContext,
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
} from "../../http-types.js";
import {
  deliverVerificationCodeToGuardian,
  deliverVerificationCodeToRequester,
  type DeliveryResult,
  handleAccessRequestDecision,
  notifyRequesterOfApproval,
  notifyRequesterOfDeliveryFailure,
  notifyRequesterOfDenial,
} from "../access-request-decision.js";
import { parseCallbackData } from "../channel-route-shared.js";
import {
  deliverIdentityMismatchReply,
  deliverStaleApprovalReply,
} from "../guardian-approval-reply-helpers.js";

const log = getLogger("runtime-http");

export interface GuardianCallbackDecisionParams {
  content: string;
  callbackData?: string;
  conversationExternalId: string;
  sourceChannel: ChannelId;
  actorExternalId: string;
  replyCallbackUrl: string;
  bearerToken?: string;
  assistantId: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  approvalConversationGenerator?: ApprovalConversationGenerator;
}

export interface ApprovalInterceptionResult {
  handled: boolean;
  type?:
    | "decision_applied"
    | "assistant_turn"
    | "guardian_decision_applied"
    | "stale_ignored";
}

/**
 * Handle a guardian sender's message when there are pending guardian approval
 * requests targeting this chat. Returns `{ handled: true }` when the message
 * was consumed, or `null` when no guardian approval was found and the caller
 * should fall through to standard approval interception.
 */
export async function handleGuardianCallbackDecision(
  params: GuardianCallbackDecisionParams,
): Promise<ApprovalInterceptionResult | null> {
  const {
    content,
    callbackData,
    conversationExternalId,
    sourceChannel,
    actorExternalId,
    replyCallbackUrl,
    bearerToken,
    assistantId,
    approvalCopyGenerator,
    approvalConversationGenerator,
  } = params;

  // Callback/button path: deterministic and takes priority.
  let callbackDecision: ApprovalDecisionResult | null = null;
  if (callbackData) {
    callbackDecision = parseCallbackData(callbackData, sourceChannel);
  }

  // When a callback button provides a request ID, use the scoped lookup so
  // the decision resolves to exactly the right approval even when
  // multiple approvals target the same guardian chat.
  let guardianApproval = callbackDecision?.requestId
    ? getPendingApprovalByRequestAndGuardianChat(
        callbackDecision.requestId,
        sourceChannel,
        conversationExternalId,
      )
    : null;

  // When the scoped lookup didn't resolve an approval (either because
  // there was no callback or the requestId pointed to a stale/expired request),
  // fall back to checking all pending approvals for this guardian chat.
  if (!guardianApproval && callbackDecision) {
    const allPending = getAllPendingApprovalsByGuardianChat(
      sourceChannel,
      conversationExternalId,
    );
    if (allPending.length === 1) {
      guardianApproval = allPending[0];
    } else if (allPending.length > 1) {
      // The callback targeted a stale/expired request but the guardian has other
      // pending approvals. Inform them the clicked approval is no longer valid.
      await deliverStaleApprovalReply({
        scenario: "guardian_disambiguation",
        sourceChannel,
        replyCallbackUrl,
        chatId: conversationExternalId,
        assistantId,
        bearerToken,
        approvalCopyGenerator,
        logger: log,
        errorLogMessage:
          "Failed to deliver stale callback disambiguation notice",
        extraContext: { pendingCount: allPending.length },
        errorLogContext: { conversationExternalId },
      });
      return { handled: true, type: "stale_ignored" };
    }
  }

  // For plain-text messages (no callback), check if there are any pending
  // approvals for this guardian chat to route through the conversation engine.
  if (!guardianApproval && !callbackDecision) {
    const allPending = getAllPendingApprovalsByGuardianChat(
      sourceChannel,
      conversationExternalId,
    );
    if (allPending.length === 1) {
      guardianApproval = allPending[0];
    } else if (allPending.length > 1) {
      // Multiple pending — pick the first approval matching this sender as
      // primary context. The conversation engine sees all matching approvals
      // via pendingApprovals and can disambiguate.
      guardianApproval =
        allPending.find((a) => a.guardianExternalUserId === actorExternalId) ??
        allPending[0];
    }
  }

  if (!guardianApproval) {
    return null;
  }

  // Validate that the sender is the specific guardian who was assigned
  // this approval request. This is a defense-in-depth check — the
  // trustClass check above already verifies the sender is a guardian,
  // but this catches edge cases like binding rotation between request
  // creation and decision.
  if (actorExternalId !== guardianApproval.guardianExternalUserId) {
    log.warn(
      {
        conversationExternalId,
        actorExternalId,
        expectedGuardian: guardianApproval.guardianExternalUserId,
      },
      "Non-guardian sender attempted to act on guardian approval request",
    );
    await deliverIdentityMismatchReply({
      sourceChannel,
      replyCallbackUrl,
      chatId: conversationExternalId,
      assistantId,
      bearerToken,
      approvalCopyGenerator,
      logger: log,
      errorLogMessage: "Failed to deliver guardian identity rejection notice",
      errorLogContext: { conversationExternalId },
    });
    return { handled: true, type: "guardian_decision_applied" };
  }

  if (callbackDecision) {
    return handleCallbackDecision({
      guardianApproval,
      callbackDecision,
      actorExternalId,
      sourceChannel,
      replyCallbackUrl,
      assistantId,
      bearerToken,
      approvalCopyGenerator,
    });
  }

  // ── Conversational engine for guardian plain-text messages ──
  const allGuardianPending = getAllPendingApprovalsByGuardianChat(
    sourceChannel,
    conversationExternalId,
  );
  // Only present approvals that belong to this sender so the engine
  // does not offer disambiguation for requests assigned to a rotated
  // guardian the sender cannot act on.
  const senderPending = allGuardianPending.filter(
    (a) => a.guardianExternalUserId === actorExternalId,
  );
  const effectivePending =
    senderPending.length > 0 ? senderPending : allGuardianPending;

  if (effectivePending.length > 0 && content && approvalConversationGenerator) {
    return handleConversationalDecision({
      guardianApproval,
      allGuardianPending,
      effectivePending,
      actorExternalId,
      sourceChannel,
      conversationExternalId,
      replyCallbackUrl,
      content,
      assistantId,
      bearerToken,
      approvalCopyGenerator,
      approvalConversationGenerator,
    });
  }

  // Guardian sent a plain-text message with pending approvals but the
  // conversational engine is unavailable. Return a handled result with a
  // generative reply so the guardian gets feedback instead of the message being
  // silently swallowed by the standard approval flow.
  //
  // Exclude callback/reaction payloads (e.g. `reaction:+1`) — these carry
  // `callbackData` and must fall through so `handleApprovalInterception` can
  // route them to the deterministic reaction handler.
  if (effectivePending.length > 0 && content && !callbackData) {
    try {
      const text = await composeApprovalMessageGenerative(
        {
          scenario: "guardian_text_unavailable",
          channel: sourceChannel,
        },
        {},
        approvalCopyGenerator,
      );
      await deliverChannelReply(
        replyCallbackUrl,
        {
          chatId: conversationExternalId,
          text,
          assistantId,
        },
        bearerToken,
      );
    } catch (err) {
      log.error(
        { err, conversationExternalId },
        "Failed to deliver guardian fallback reply",
      );
    }
    return { handled: true, type: "assistant_turn" };
  }

  // No content — nothing actionable.
  return null;
}

// ---------------------------------------------------------------------------
// Callback decision handler
// ---------------------------------------------------------------------------

async function handleCallbackDecision(params: {
  guardianApproval: GuardianApprovalRequest;
  callbackDecision: ApprovalDecisionResult;
  actorExternalId: string;
  sourceChannel: ChannelId;
  replyCallbackUrl: string;
  assistantId: string;
  bearerToken?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
}): Promise<ApprovalInterceptionResult> {
  const {
    guardianApproval,
    callbackDecision,
    actorExternalId,
    sourceChannel,
    replyCallbackUrl,
    assistantId,
    bearerToken,
    approvalCopyGenerator,
  } = params;

  // Access request approvals don't have a pending interaction in the
  // session tracker, so they need a separate decision path that creates
  // a verification session instead of resuming an agent loop.
  if (guardianApproval.toolName === "ingress_access_request") {
    const accessResult = await handleAccessRequestApproval(
      guardianApproval,
      callbackDecision.action === "reject" ? "deny" : "approve",
      actorExternalId,
      replyCallbackUrl,
      assistantId,
      bearerToken,
    );
    return accessResult;
  }

  // Apply the decision through the unified guardian decision primitive.
  // The primitive handles approve_always downgrade, approval info capture,
  // record update, and scoped grant minting.
  const result = applyGuardianDecision({
    approval: guardianApproval,
    decision: callbackDecision,
    actorPrincipalId: undefined, // Callback path — principal not available at this layer
    actorExternalUserId: actorExternalId, // Channel-native ID (Telegram user ID, phone, etc.)
    actorChannel: sourceChannel,
  });

  if (result.applied) {
    // Notify the requester's chat about the outcome with the tool name
    const effectiveAction =
      callbackDecision.action === "approve_always"
        ? "approve_once"
        : callbackDecision.action;
    const outcomeText = await composeApprovalMessageGenerative(
      {
        scenario: "guardian_decision_outcome",
        decision: effectiveAction === "reject" ? "denied" : "approved",
        toolName: guardianApproval.toolName,
        channel: sourceChannel,
      },
      {},
      approvalCopyGenerator,
    );
    try {
      await deliverChannelReply(
        replyCallbackUrl,
        {
          chatId: guardianApproval.requesterChatId,
          text: outcomeText,
          assistantId,
        },
        bearerToken,
      );
    } catch (err) {
      log.error(
        { err, conversationId: guardianApproval.conversationId },
        "Failed to notify requester of guardian decision",
      );
    }

    // Post-decision delivery is handled by the onEvent callback
    // in the session that registered the pending interaction.
    return { handled: true, type: "guardian_decision_applied" };
  }

  // Race condition: callback arrived after request was already resolved.
  return { handled: true, type: "stale_ignored" };
}

// ---------------------------------------------------------------------------
// Conversational engine decision handler
// ---------------------------------------------------------------------------

async function handleConversationalDecision(params: {
  guardianApproval: GuardianApprovalRequest;
  allGuardianPending: GuardianApprovalRequest[];
  effectivePending: GuardianApprovalRequest[];
  actorExternalId: string;
  sourceChannel: ChannelId;
  conversationExternalId: string;
  replyCallbackUrl: string;
  content: string;
  assistantId: string;
  bearerToken?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  approvalConversationGenerator: ApprovalConversationGenerator;
}): Promise<ApprovalInterceptionResult> {
  const {
    guardianApproval,
    allGuardianPending,
    effectivePending,
    actorExternalId,
    sourceChannel,
    conversationExternalId,
    replyCallbackUrl,
    content,
    assistantId,
    bearerToken,
    approvalCopyGenerator,
    approvalConversationGenerator,
  } = params;

  const guardianAllowedActions = ["approve_once", "reject"];
  const engineContext: ApprovalConversationContext = {
    toolName: guardianApproval.toolName,
    allowedActions: guardianAllowedActions,
    role: "guardian",
    pendingApprovals: effectivePending.map((a) => ({
      requestId: a.requestId!,
      toolName: a.toolName,
    })),
    userMessage: content,
  };

  const engineResult = await runApprovalConversationTurn(
    engineContext,
    approvalConversationGenerator,
  );

  if (engineResult.disposition === "keep_pending") {
    // Non-decision follow-up (clarification, disambiguation, etc.)
    try {
      await deliverChannelReply(
        replyCallbackUrl,
        {
          chatId: conversationExternalId,
          text: engineResult.replyText,
          assistantId,
        },
        bearerToken,
      );
    } catch (err) {
      log.error(
        { err, conversationId: guardianApproval.conversationId },
        "Failed to deliver guardian conversation reply",
      );
    }
    return { handled: true, type: "assistant_turn" };
  }

  // Decision-bearing disposition from the engine
  let decisionAction = engineResult.disposition as ApprovalAction;

  // Belt-and-suspenders: guardians cannot use broad allow modes even if
  // the engine returns them (the engine's allowedActions validation should
  // already prevent this, but enforce it here too).
  if (
    decisionAction === "approve_always" ||
    decisionAction === "approve_10m" ||
    decisionAction === "approve_conversation"
  ) {
    decisionAction = "approve_once";
  }

  // Resolve the target approval: use targetRequestId from the engine if
  // provided, otherwise use the single guardian approval.
  const targetApproval = engineResult.targetRequestId
    ? (allGuardianPending.find(
        (a) => a.requestId === engineResult.targetRequestId,
      ) ?? guardianApproval)
    : guardianApproval;

  // Re-validate guardian identity against the resolved target. The
  // engine may select a different pending approval (via targetRequestId)
  // that was assigned to a different guardian. Without this check a
  // currently bound guardian could act on a request assigned to a
  // previous guardian after a binding rotation.
  if (actorExternalId !== targetApproval.guardianExternalUserId) {
    log.warn(
      {
        conversationExternalId,
        actorExternalId,
        expectedGuardian: targetApproval.guardianExternalUserId,
        targetRequestId: engineResult.targetRequestId,
      },
      "Guardian identity mismatch on engine-selected target approval",
    );
    await deliverIdentityMismatchReply({
      sourceChannel,
      replyCallbackUrl,
      chatId: conversationExternalId,
      assistantId,
      bearerToken,
      approvalCopyGenerator,
      logger: log,
      errorLogMessage:
        "Failed to deliver guardian identity mismatch notice for engine target",
      errorLogContext: { conversationExternalId },
    });
    return { handled: true, type: "guardian_decision_applied" };
  }

  // Access request approvals need a separate decision path.
  if (targetApproval.toolName === "ingress_access_request") {
    const accessResult = await handleAccessRequestApproval(
      targetApproval,
      decisionAction === "reject" ? "deny" : "approve",
      actorExternalId,
      replyCallbackUrl,
      assistantId,
      bearerToken,
    );
    return accessResult;
  }

  const engineDecision: ApprovalDecisionResult = {
    action: decisionAction,
    source: "plain_text",
    ...(engineResult.targetRequestId
      ? { requestId: engineResult.targetRequestId }
      : {}),
  };

  // Apply the decision through the unified guardian decision primitive.
  const result = applyGuardianDecision({
    approval: targetApproval,
    decision: engineDecision,
    actorPrincipalId: undefined, // Callback path — principal not available at this layer
    actorExternalUserId: actorExternalId, // Channel-native ID (Telegram user ID, phone, etc.)
    actorChannel: sourceChannel,
  });

  if (result.applied) {
    // Notify the requester's chat about the outcome
    const outcomeText = await composeApprovalMessageGenerative(
      {
        scenario: "guardian_decision_outcome",
        decision: decisionAction === "reject" ? "denied" : "approved",
        toolName: targetApproval.toolName,
        channel: sourceChannel,
      },
      {},
      approvalCopyGenerator,
    );
    try {
      await deliverChannelReply(
        replyCallbackUrl,
        {
          chatId: targetApproval.requesterChatId,
          text: outcomeText,
          assistantId,
        },
        bearerToken,
      );
    } catch (err) {
      log.error(
        { err, conversationId: targetApproval.conversationId },
        "Failed to notify requester of guardian decision",
      );
    }

    // Deliver the engine's reply to the guardian
    try {
      await deliverChannelReply(
        replyCallbackUrl,
        {
          chatId: conversationExternalId,
          text: engineResult.replyText,
          assistantId,
        },
        bearerToken,
      );
    } catch (err) {
      log.error(
        { err, conversationId: targetApproval.conversationId },
        "Failed to deliver guardian decision reply",
      );
    }

    return { handled: true, type: "guardian_decision_applied" };
  }

  // Race condition: request was already resolved. Deliver a stale notice
  // instead of the engine's optimistic reply.
  await deliverStaleApprovalReply({
    scenario: "approval_already_resolved",
    sourceChannel,
    replyCallbackUrl,
    chatId: conversationExternalId,
    assistantId,
    bearerToken,
    approvalCopyGenerator,
    logger: log,
    errorLogMessage: "Failed to deliver stale guardian approval notice",
    errorLogContext: { conversationId: targetApproval.conversationId },
  });

  return { handled: true, type: "stale_ignored" };
}

// ---------------------------------------------------------------------------
// Access request decision helper
// ---------------------------------------------------------------------------

/**
 * Handle a guardian's decision on an `ingress_access_request` approval.
 * Delegates to the access-request-decision module and orchestrates
 * notification delivery.
 *
 * On approve: creates a verification session, delivers the code to the
 * guardian, and notifies the requester to expect a code.
 *
 * On deny: marks the request as denied and notifies the requester.
 */
async function handleAccessRequestApproval(
  approval: GuardianApprovalRequest,
  action: "approve" | "deny",
  decidedByExternalUserId: string,
  replyCallbackUrl: string,
  assistantId: string,
  bearerToken?: string,
): Promise<ApprovalInterceptionResult> {
  const decisionResult = handleAccessRequestDecision(
    approval,
    action,
    decidedByExternalUserId,
  );

  if (decisionResult.type === "stale" || decisionResult.type === "idempotent") {
    return { handled: true, type: "stale_ignored" };
  }

  if (decisionResult.type === "denied") {
    await notifyRequesterOfDenial({
      replyCallbackUrl,
      requesterChatId: approval.requesterChatId,
      assistantId,
      bearerToken,
      channel: approval.channel,
      requesterExternalUserId: approval.requesterExternalUserId,
    });

    // Emit both guardian_decision and denied signals so all lifecycle
    // observers are notified of the denial.
    const deniedPayload = {
      sourceChannel: approval.channel as NotificationSourceChannel,
      requesterExternalUserId: approval.requesterExternalUserId,
      requesterChatId: approval.requesterChatId,
      decidedByExternalUserId,
      decision: "denied" as const,
    };

    void emitNotificationSignal({
      sourceEventName: "ingress.trusted_contact.guardian_decision",
      sourceChannel: approval.channel as NotificationSourceChannel,
      sourceContextId: approval.conversationId,
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: deniedPayload,
      dedupeKey: `trusted-contact:guardian-decision:${approval.id}`,
    });

    void emitNotificationSignal({
      sourceEventName: "ingress.trusted_contact.denied",
      sourceChannel: approval.channel as NotificationSourceChannel,
      sourceContextId: approval.conversationId,
      attentionHints: {
        requiresAction: false,
        urgency: "low",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: deniedPayload,
      dedupeKey: `trusted-contact:denied:${approval.id}`,
    });

    return { handled: true, type: "guardian_decision_applied" };
  }

  // Approved: deliver the verification code to the guardian and notify the requester.
  const requesterIdentifier = approval.requesterExternalUserId;

  let codeDelivered = true;
  if (decisionResult.verificationCode) {
    const deliveryResult: DeliveryResult =
      await deliverVerificationCodeToGuardian({
        replyCallbackUrl,
        guardianChatId: approval.guardianChatId,
        requesterIdentifier,
        verificationCode: decisionResult.verificationCode,
        assistantId,
        bearerToken,
      });
    if (!deliveryResult.ok) {
      log.error(
        { reason: deliveryResult.reason, approvalId: approval.id },
        "Skipping requester notification — verification code was not delivered to guardian",
      );
      codeDelivered = false;
    }
  }

  // On Slack, auto-deliver the verification code directly to the requester's
  // DM so the guardian doesn't have to manually share it. The identity binding
  // still protects against abuse — only the bound user can consume the code.
  let requesterCodeDelivered = false;
  if (
    codeDelivered &&
    approval.channel === "slack" &&
    decisionResult.verificationCode
  ) {
    const requesterCodeResult = await deliverVerificationCodeToRequester({
      replyCallbackUrl,
      requesterChatId: approval.requesterChatId,
      verificationCode: decisionResult.verificationCode,
      assistantId,
      bearerToken,
      channel: approval.channel,
      requesterExternalUserId: approval.requesterExternalUserId,
    });
    if (requesterCodeResult.ok) {
      requesterCodeDelivered = true;
    } else {
      log.error(
        { reason: requesterCodeResult.reason, approvalId: approval.id },
        "Failed to auto-deliver verification code to requester on Slack",
      );
    }
  }

  // Skip the separate approval notification when the requester already
  // received the verification code directly (on Slack both messages go
  // to the same DM, so sending both is redundant).
  if (codeDelivered && !requesterCodeDelivered) {
    await notifyRequesterOfApproval({
      replyCallbackUrl,
      requesterChatId: approval.requesterChatId,
      assistantId,
      bearerToken,
      channel: approval.channel,
      requesterExternalUserId: approval.requesterExternalUserId,
    });
  } else if (!codeDelivered) {
    // Let the requester know something went wrong without revealing details
    await notifyRequesterOfDeliveryFailure({
      replyCallbackUrl,
      requesterChatId: approval.requesterChatId,
      assistantId,
      bearerToken,
      channel: approval.channel,
      requesterExternalUserId: approval.requesterExternalUserId,
    });
  }

  // Don't emit guardian_decision for approvals that still require code
  // verification — the guardian already received the code, and emitting
  // this signal prematurely causes the notification pipeline to deliver
  // a confusing "approved" message before the requester has verified.
  // The guardian_decision signal should only fire once access is fully granted
  // (i.e. after code consumption), which is handled in the verification path.
  if (!decisionResult.verificationSessionId) {
    void emitNotificationSignal({
      sourceEventName: "ingress.trusted_contact.guardian_decision",
      sourceChannel: approval.channel as NotificationSourceChannel,
      sourceContextId: approval.conversationId,
      attentionHints: {
        requiresAction: false,
        urgency: "medium",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: {
        sourceChannel: approval.channel as NotificationSourceChannel,
        requesterExternalUserId: approval.requesterExternalUserId,
        requesterChatId: approval.requesterChatId,
        decidedByExternalUserId,
        decision: "approved",
      },
      dedupeKey: `trusted-contact:guardian-decision:${approval.id}`,
    });
  }

  // Emit verification_sent with visibleInSourceNow=true so the notification
  // pipeline suppresses delivery — the guardian already received the
  // verification code directly. Without this flag, the pipeline generates
  // a redundant LLM message like "Good news! Your request has been approved."
  if (decisionResult.verificationSessionId && codeDelivered) {
    void emitNotificationSignal({
      sourceEventName: "ingress.trusted_contact.verification_sent",
      sourceChannel: approval.channel as NotificationSourceChannel,
      sourceContextId: approval.conversationId,
      attentionHints: {
        requiresAction: false,
        urgency: "low",
        isAsyncBackground: true,
        visibleInSourceNow: true,
      },
      contextPayload: {
        sourceChannel: approval.channel as NotificationSourceChannel,
        requesterExternalUserId: approval.requesterExternalUserId,
        requesterChatId: approval.requesterChatId,
        verificationSessionId: decisionResult.verificationSessionId,
      },
      dedupeKey: `trusted-contact:verification-sent:${decisionResult.verificationSessionId}`,
    });
  }

  return { handled: true, type: "guardian_decision_applied" };
}
