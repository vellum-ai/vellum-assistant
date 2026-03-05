/**
 * Shared helper for minting scoped approval grants when a guardian-action
 * request is resolved with tool metadata.
 *
 * Used by both the channel inbound path (inbound-message-handler.ts) and
 * the desktop/IPC path (session-process.ts) to ensure grants are minted
 * consistently regardless of which channel the guardian answers on.
 */

import { mintGrantFromDecision } from "../approvals/approval-primitive.js";
import type { GuardianActionRequest } from "../memory/guardian-action-store.js";
import { getLogger } from "../util/logger.js";
import { runApprovalConversationTurn } from "./approval-conversation-turn.js";
import { parseApprovalDecision } from "./channel-approval-parser.js";
import type { ApprovalConversationGenerator } from "./http-types.js";

const log = getLogger("guardian-action-grant-minter");

/** TTL for scoped approval grants minted on guardian-action answer resolution. */
export const GUARDIAN_ACTION_GRANT_TTL_MS = 5 * 60 * 1000;

/**
 * Mint a `tool_signature` scoped grant when a guardian-action request is
 * resolved and the request carries tool metadata (toolName + inputDigest).
 *
 * Uses two-tier classification:
 *   1. Deterministic fast path via parseApprovalDecision (exact keyword match).
 *   2. LLM fallback via runApprovalConversationTurn when the deterministic
 *      parser returns null and an approvalConversationGenerator is provided.
 *
 * Skips silently when:
 *   - The resolved request has no toolName/inputDigest (informational consult).
 *   - The guardian's answer is not classified as approval by either tier (fail-closed).
 *
 * Fails silently on error -- grant minting is best-effort and must never
 * block the guardian-action answer flow.
 */
export async function tryMintGuardianActionGrant(params: {
  request: GuardianActionRequest;
  answerText: string;
  decisionChannel: string;
  guardianExternalUserId?: string;
  approvalConversationGenerator?: ApprovalConversationGenerator;
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

  // Tier 1: Deterministic fast path -- try exact keyword matching first.
  // Guardian-action invariant: grants are always one-time `tool_signature`
  // scoped.  We treat `approve_always` from the deterministic parser the
  // same as `approve_once` -- the grant is still single-use.  This keeps
  // the guardian-action path aligned with the primary approval interception
  // flow where guardians are limited to approve_once / reject.
  const decision = parseApprovalDecision(answerText);
  let isApproval =
    decision?.action === "approve_once" ||
    decision?.action === "approve_always";

  // Tier 2: LLM fallback -- when the deterministic parser found no match
  // and a generator is available, delegate to the conversational engine.
  // Only allow approve_once (not approve_always) to keep guardian-action
  // grants strictly one-time and consistent with guardian policy.
  if (!isApproval && !decision && approvalConversationGenerator) {
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
          event: "guardian_action_grant_llm_fallback",
          toolName: request.toolName,
          requestId: request.id,
          answerText,
          llmDisposition: llmResult.disposition,
          matched: isApproval,
          decisionChannel,
        },
        `LLM fallback classifier returned disposition: ${llmResult.disposition}`,
      );
    } catch (err) {
      // Fail-closed: generator errors must not produce grants.
      log.warn(
        {
          event: "guardian_action_grant_llm_fallback_error",
          toolName: request.toolName,
          requestId: request.id,
          err,
          decisionChannel,
        },
        "LLM fallback classifier threw an error; treating as non-approval (fail-closed)",
      );
    }
  }

  if (!isApproval) {
    log.info(
      {
        event: "guardian_action_grant_skipped_no_approval",
        toolName: request.toolName,
        requestId: request.id,
        answerText,
        parsedAction: decision?.action ?? null,
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
    expiresAt: new Date(
      Date.now() + GUARDIAN_ACTION_GRANT_TTL_MS,
    ).toISOString(),
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
