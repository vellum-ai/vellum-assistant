/**
 * Guardian text engine strategy: handles plain-text approval messages through
 * the conversational approval engine when an approvalConversationGenerator is
 * available. Classifies natural language and responds conversationally.
 */
import type { ChannelId } from "../../../channels/types.js";
import { getLogger } from "../../../util/logger.js";
import { runApprovalConversationTurn } from "../../approval-conversation-turn.js";
import type {
  ApprovalAction,
  ApprovalDecisionResult,
} from "../../channel-approval-types.js";
import { handleChannelDecision } from "../../channel-approvals.js";
import { deliverChannelReply } from "../../gateway-client.js";
import type {
  ApprovalConversationContext,
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
} from "../../http-types.js";
import type { ApprovalInterceptionResult } from "../guardian-approval-interception.js";
import { deliverStaleApprovalReply } from "../guardian-approval-reply-helpers.js";

const log = getLogger("runtime-http");

/**
 * Resolve the Slack ephemeral user ID when the source channel is Slack.
 * Returns `undefined` for non-Slack channels.
 */
function slackEphemeralUserId(
  sourceChannel: ChannelId,
  userId: string | undefined,
): string | undefined {
  return sourceChannel === "slack" && userId ? userId : undefined;
}

export interface TextEngineDecisionParams {
  conversationId: string;
  conversationExternalId: string;
  sourceChannel: ChannelId;
  replyCallbackUrl: string;
  content: string;
  assistantId: string;
  bearerToken?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  approvalConversationGenerator: ApprovalConversationGenerator;
  /** Pending approval info for this conversation. */
  pending: Array<{ requestId: string; toolName: string }>;
  /** Allowed actions from the pending prompt. */
  allowedActions: string[];
  /** External user ID of the actor (for Slack ephemeral routing). */
  actorExternalId?: string;
}

/**
 * Handle a plain-text message through the conversational approval engine.
 * Returns an interception result when the engine produces a decision or
 * conversational reply, or null if the engine couldn't handle the message.
 */
export async function handleGuardianTextEngineDecision(
  params: TextEngineDecisionParams,
): Promise<ApprovalInterceptionResult> {
  const {
    conversationId,
    conversationExternalId,
    sourceChannel,
    replyCallbackUrl,
    content,
    assistantId,
    bearerToken,
    approvalCopyGenerator,
    approvalConversationGenerator,
    pending,
    allowedActions,
    actorExternalId,
  } = params;

  const engineContext: ApprovalConversationContext = {
    toolName: pending[0].toolName,
    allowedActions,
    role: "requester",
    pendingApprovals: pending.map((p) => ({
      requestId: p.requestId,
      toolName: p.toolName,
    })),
    userMessage: content,
  };

  const engineResult = await runApprovalConversationTurn(
    engineContext,
    approvalConversationGenerator,
  );

  if (engineResult.disposition === "keep_pending") {
    // Non-decision follow-up — deliver the engine's reply and keep the request pending
    try {
      const keepPendingPayload: Parameters<typeof deliverChannelReply>[1] = {
        chatId: conversationExternalId,
        text: engineResult.replyText,
        assistantId,
      };
      const ephemeral = slackEphemeralUserId(sourceChannel, actorExternalId);
      if (ephemeral) {
        keepPendingPayload.ephemeral = true;
        keepPendingPayload.user = ephemeral;
      }
      await deliverChannelReply(
        replyCallbackUrl,
        keepPendingPayload,
        bearerToken,
      );
    } catch (err) {
      log.error(
        { err, conversationId },
        "Failed to deliver approval conversation reply",
      );
    }
    return { handled: true, type: "assistant_turn" };
  }

  // Decision-bearing disposition — map to ApprovalDecisionResult and apply
  const decisionAction = engineResult.disposition as ApprovalAction;
  const engineDecision: ApprovalDecisionResult = {
    action: decisionAction,
    source: "plain_text",
    ...(engineResult.targetRequestId
      ? { requestId: engineResult.targetRequestId }
      : {}),
  };

  const result = handleChannelDecision(conversationId, engineDecision);

  if (result.applied) {
    // Deliver the engine's reply text to the user
    try {
      const decisionPayload: Parameters<typeof deliverChannelReply>[1] = {
        chatId: conversationExternalId,
        text: engineResult.replyText,
        assistantId,
      };
      const ephemeral = slackEphemeralUserId(sourceChannel, actorExternalId);
      if (ephemeral) {
        decisionPayload.ephemeral = true;
        decisionPayload.user = ephemeral;
      }
      await deliverChannelReply(replyCallbackUrl, decisionPayload, bearerToken);
    } catch (err) {
      log.error(
        { err, conversationId },
        "Failed to deliver approval decision reply",
      );
    }

    return { handled: true, type: "decision_applied" };
  }

  // Race condition: request was already resolved by expiry sweep or
  // concurrent callback. Deliver a stale notice instead of the
  // engine's optimistic reply.
  await deliverStaleApprovalReply({
    scenario: "approval_already_resolved",
    sourceChannel,
    replyCallbackUrl,
    chatId: conversationExternalId,
    assistantId,
    bearerToken,
    approvalCopyGenerator,
    logger: log,
    errorLogMessage: "Failed to deliver stale approval notice",
    errorLogContext: { conversationId },
    ephemeralUserId: slackEphemeralUserId(sourceChannel, actorExternalId),
  });

  return { handled: true, type: "stale_ignored" };
}
