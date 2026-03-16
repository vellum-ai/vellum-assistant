/**
 * Shared helper for minting scoped approval grants when a guardian-action
 * request is resolved with tool metadata.
 *
 * Used by both the channel inbound path (inbound-message-handler.ts) and
 * the desktop path (conversation-process.ts) to ensure grants are minted
 * consistently regardless of which channel the guardian answers on.
 */

import { mintGrantFromDecision } from "../approvals/approval-primitive.js";
import type { GuardianActionRequest } from "../memory/guardian-action-store.js";
import { getLogger } from "../util/logger.js";
import { runApprovalConversationTurn } from "./approval-conversation-turn.js";
import type { ApprovalConversationGenerator } from "./http-types.js";

const log = getLogger("guardian-action-grant-minter");

/** TTL for scoped approval grants minted on guardian-action answer resolution. */
export const GUARDIAN_ACTION_GRANT_TTL_MS = 5 * 60 * 1000;

/**
 * Mint a `tool_signature` scoped grant when a guardian-action request is
 * resolved and the request carries tool metadata (toolName + inputDigest).
 *
 * Classifies the guardian's answer via the conversational approval engine
 * (`runApprovalConversationTurn`). Only `approve_once` produces a grant —
 * guardian-action grants are always single-use `tool_signature` scoped.
 *
 * Skips silently when:
 *   - The resolved request has no toolName/inputDigest (informational consult).
 *   - The guardian's answer is not classified as approval (fail-closed).
 *
 * Fails silently on error -- grant minting is best-effort and must never
 * block the guardian-action answer flow.
 */
export async function tryMintGuardianActionGrant(params: {
  request: GuardianActionRequest;
  answerText: string;
  decisionChannel: string;
  guardianExternalUserId?: string;
  approvalConversationGenerator: ApprovalConversationGenerator;
}): Promise<void> {
  const {
    request,
    answerText,
    decisionChannel,
    guardianExternalUserId,
    approvalConversationGenerator,
  } = params;

  // Only mint for requests that carry tool metadata -- informational
  // ASK_GUARDIAN consults without tool context do not produce grants.
  if (!request.toolName || !request.inputDigest) {
    return;
  }

  // Classify the guardian's answer via the conversational approval engine.
  // Only allow approve_once (not approve_always) to keep guardian-action
  // grants strictly one-time and consistent with guardian policy.
  let isApproval = false;
  try {
    const llmResult = await runApprovalConversationTurn(
      {
        toolName: request.toolName,
        allowedActions: ["approve_once", "reject"],
        role: "guardian",
        pendingApprovals: [
          { requestId: request.id, toolName: request.toolName },
        ],
        userMessage: answerText,
      },
      approvalConversationGenerator,
    );

    isApproval = llmResult.disposition === "approve_once";

    log.info(
      {
        event: "guardian_action_grant_classification",
        toolName: request.toolName,
        requestId: request.id,
        answerText,
        llmDisposition: llmResult.disposition,
        matched: isApproval,
        decisionChannel,
      },
      `Approval classifier returned disposition: ${llmResult.disposition}`,
    );
  } catch (err) {
    // Fail-closed: generator errors must not produce grants.
    log.warn(
      {
        event: "guardian_action_grant_classification_error",
        toolName: request.toolName,
        requestId: request.id,
        err,
        decisionChannel,
      },
      "Approval classifier threw an error; treating as non-approval (fail-closed)",
    );
  }

  if (!isApproval) {
    log.info(
      {
        event: "guardian_action_grant_skipped_no_approval",
        toolName: request.toolName,
        requestId: request.id,
        answerText,
        decisionChannel,
      },
      "Skipped grant minting: guardian answer not classified as approval",
    );
    return;
  }

  const result = mintGrantFromDecision({
    scopeMode: "tool_signature",
    toolName: request.toolName,
    inputDigest: request.inputDigest,
    requestChannel: request.sourceChannel,
    decisionChannel,
    executionChannel: null,
    conversationId: request.sourceConversationId,
    callSessionId: request.callSessionId,
    guardianExternalUserId: guardianExternalUserId ?? null,
    expiresAt: Date.now() + GUARDIAN_ACTION_GRANT_TTL_MS,
  });

  if (result.ok) {
    log.info(
      {
        event: "guardian_action_grant_minted",
        toolName: request.toolName,
        requestId: request.id,
        callSessionId: request.callSessionId,
        decisionChannel,
      },
      "Minted scoped approval grant for guardian-action answer resolution",
    );
  } else {
    log.error(
      {
        reason: result.reason,
        toolName: request.toolName,
        requestId: request.id,
      },
      "Failed to mint scoped approval grant for guardian-action (non-fatal)",
    );
  }
}
