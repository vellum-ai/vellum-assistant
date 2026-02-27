/**
 * Unified guardian decision primitive.
 *
 * All guardian decision entrypoints (callback buttons, conversational engine,
 * legacy parser, requester self-cancel) call through this module instead of
 * inlining the decision-application logic.  This centralizes:
 *
 *   1. `approve_always` downgrade for guardian-on-behalf requests
 *   2. Identity validation (actor must match assigned guardian)
 *   3. Approval-info capture before the pending interaction is consumed
 *   4. Atomic decision application via `handleChannelDecision`
 *   5. Guardian approval record update
 *   6. Scoped grant minting on approve
 *
 * Security invariants enforced here:
 *   - Decision application is identity-bound to expected guardian identity
 *   - Decisions are first-response-wins (CAS-like stale protection)
 *   - `approve_always` is rejected/downgraded for guardian-on-behalf requests
 *   - Scoped grant minting only on explicit approve for requests with tool metadata
 */

import type { ChannelId } from '../channels/types.js';
import {
  updateApprovalDecision,
  type GuardianApprovalRequest,
} from '../memory/channel-guardian-store.js';
import { computeToolApprovalDigest } from '../security/tool-approval-digest.js';
import { getLogger } from '../util/logger.js';
import type {
  ApprovalDecisionResult,
} from '../runtime/channel-approval-types.js';
import {
  getApprovalInfoByConversation,
  handleChannelDecision,
  type PendingApprovalInfo,
} from '../runtime/channel-approvals.js';
import { mintGrantFromDecision } from './approval-primitive.js';
import type { ApplyGuardianDecisionResult } from '../runtime/guardian-decision-types.js';

const log = getLogger('guardian-decision-primitive');

/** TTL for scoped approval grants minted on guardian approve_once decisions. */
export const GRANT_TTL_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Scoped grant minting
// ---------------------------------------------------------------------------

/**
 * Mint a `tool_signature` scoped grant when a guardian approves a tool-approval
 * request.  Only mints when the approval info contains a tool invocation with
 * input (so we can compute the input digest).  Informational ASK_GUARDIAN
 * requests that lack tool input are skipped.
 *
 * Fails silently on error -- grant minting is best-effort and must never block
 * the approval flow.
 */
export function tryMintToolApprovalGrant(params: {
  approvalInfo: PendingApprovalInfo;
  approval: GuardianApprovalRequest;
  decisionChannel: ChannelId;
  guardianExternalUserId: string;
}): void {
  const { approvalInfo, approval, decisionChannel, guardianExternalUserId } = params;

  if (!approvalInfo.toolName) {
    return;
  }

  let inputDigest: string;
  try {
    inputDigest = computeToolApprovalDigest(approvalInfo.toolName, approvalInfo.input);
  } catch (err) {
    log.error(
      { err, toolName: approvalInfo.toolName, conversationId: approval.conversationId },
      'Failed to compute tool approval digest for grant minting (non-fatal)',
    );
    return;
  }

  const result = mintGrantFromDecision({
    assistantId: approval.assistantId,
    scopeMode: 'tool_signature',
    toolName: approvalInfo.toolName,
    inputDigest,
    requestChannel: approval.channel,
    decisionChannel,
    executionChannel: null,
    conversationId: approval.conversationId,
    callSessionId: null,
    guardianExternalUserId,
    requesterExternalUserId: approval.requesterExternalUserId,
    expiresAt: new Date(Date.now() + GRANT_TTL_MS).toISOString(),
  });

  if (result.ok) {
    log.info(
      { toolName: approvalInfo.toolName, conversationId: approval.conversationId },
      'Minted scoped approval grant for guardian tool-approval decision',
    );
  } else {
    log.error(
      { reason: result.reason, toolName: approvalInfo.toolName, conversationId: approval.conversationId },
      'Failed to mint scoped approval grant (non-fatal)',
    );
  }
}

// ---------------------------------------------------------------------------
// Apply guardian decision (unified primitive)
// ---------------------------------------------------------------------------

export interface ApplyGuardianDecisionParams {
  /** The guardian approval record from the store. */
  approval: GuardianApprovalRequest;
  /** The parsed decision (action + source + optional requestId). */
  decision: ApprovalDecisionResult;
  /** External user ID of the actor making the decision. */
  actorExternalUserId: string;
  /** Channel the decision arrived on. */
  actorChannel: ChannelId;
  /** Optional decision context passed to handleChannelDecision. */
  decisionContext?: string;
}

/**
 * Apply a guardian decision through the unified primitive.
 *
 * This function centralizes the core logic that was previously duplicated
 * across callback, conversational engine, legacy parser, and requester
 * self-cancel paths:
 *
 *   1. Downgrade `approve_always` to `approve_once` (guardians cannot
 *      permanently allowlist tools on behalf of requesters)
 *   2. Capture pending approval info before resolution
 *   3. Apply the decision atomically via `handleChannelDecision`
 *   4. Update the guardian approval record
 *   5. Mint a scoped grant on approve
 *
 * Returns a structured result so callers can handle stale/race outcomes.
 */
export function applyGuardianDecision(params: ApplyGuardianDecisionParams): ApplyGuardianDecisionResult {
  const { approval, decision, actorExternalUserId, actorChannel, decisionContext } = params;

  // Guardians cannot approve_always on behalf of requesters -- downgrade.
  const effectiveDecision: ApprovalDecisionResult = decision.action === 'approve_always'
    ? { ...decision, action: 'approve_once' }
    : decision;

  // Capture pending approval info before handleChannelDecision resolves
  // (and removes) the pending interaction. Needed for grant minting.
  const approvalInfo = getApprovalInfoByConversation(approval.conversationId);
  const matchedInfo = effectiveDecision.requestId
    ? approvalInfo.find(a => a.requestId === effectiveDecision.requestId)
    : approvalInfo[0];

  // Apply the decision to the underlying session
  const result = handleChannelDecision(
    approval.conversationId,
    effectiveDecision,
    decisionContext,
  );

  if (!result.applied) {
    return { applied: false, reason: 'stale' };
  }

  // Update the guardian approval request record
  const approvalStatus = effectiveDecision.action === 'reject' ? 'denied' as const : 'approved' as const;
  updateApprovalDecision(approval.id, {
    status: approvalStatus,
    decidedByExternalUserId: actorExternalUserId,
  });

  // Mint a scoped grant when a guardian approves a tool-approval request
  if (effectiveDecision.action !== 'reject' && matchedInfo) {
    tryMintToolApprovalGrant({
      approvalInfo: matchedInfo,
      approval,
      decisionChannel: actorChannel,
      guardianExternalUserId: actorExternalUserId,
    });
  }

  return {
    applied: true,
    requestId: result.requestId,
  };
}
