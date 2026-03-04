/**
 * Guardian legacy fallback strategy: handles plain-text approval messages
 * through the deterministic parseApprovalDecision() parser when no
 * conversational engine is available. Preserves backward compatibility.
 */
import type { ChannelId } from "../../../channels/types.js";
import { getLogger } from "../../../util/logger.js";
import { parseApprovalDecision } from "../../channel-approval-parser.js";
import { handleChannelDecision } from "../../channel-approvals.js";
import type { ApprovalCopyGenerator } from "../../http-types.js";
import type { ApprovalInterceptionResult } from "../guardian-approval-interception.js";
import { deliverStaleApprovalReply } from "../guardian-approval-reply-helpers.js";

const log = getLogger("runtime-http");

export interface LegacyFallbackParams {
  conversationId: string;
  conversationExternalId: string;
  sourceChannel: ChannelId;
  replyCallbackUrl: string;
  content: string;
  assistantId: string;
  bearerToken?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  /** Pending approval info for this conversation. */
  pending: Array<{ requestId: string; toolName: string }>;
}

/**
 * Handle a plain-text message through the deterministic approval parser.
 * Returns an interception result when a decision is extracted and applied,
 * or null when the parser cannot extract a decision from the content.
 */
export async function handleGuardianLegacyFallback(
  params: LegacyFallbackParams,
): Promise<ApprovalInterceptionResult | null> {
  const {
    conversationId,
    conversationExternalId,
    sourceChannel,
    replyCallbackUrl,
    content,
    assistantId,
    bearerToken,
    approvalCopyGenerator,
    pending,
  } = params;

  const legacyDecision = parseApprovalDecision(content);
  if (!legacyDecision) {
    return null;
  }

  if (legacyDecision.requestId) {
    if (
      pending.length === 0 ||
      !pending.some((p) => p.requestId === legacyDecision.requestId)
    ) {
      return { handled: true, type: "stale_ignored" };
    }
  }

  const result = handleChannelDecision(conversationId, legacyDecision);
  if (result.applied) {
    return { handled: true, type: "decision_applied" };
  }

  // Race condition: request was already resolved.
  await deliverStaleApprovalReply({
    scenario: "approval_already_resolved",
    sourceChannel,
    replyCallbackUrl,
    chatId: conversationExternalId,
    assistantId,
    bearerToken,
    approvalCopyGenerator,
    logger: log,
    errorLogMessage: "Failed to deliver stale approval notice (legacy path)",
    errorLogContext: { conversationId },
  });
  return { handled: true, type: "stale_ignored" };
}
