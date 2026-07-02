/**
 * Shared service for processing guardian action decisions.
 *
 * Encapsulates the core business logic — validation, conversation scoping,
 * canonical decision application, and result mapping — so both the HTTP
 * handler and the message handler can delegate here without duplicating code.
 */

import { applyCanonicalGuardianDecision } from "../approvals/guardian-decision-primitive.js";
import {
  getCanonicalGuardianRequest,
  isRequestInConversationScope,
} from "../contacts/canonical-guardian-store.js";
import {
  APPROVAL_ACTION_IDS,
  isApprovalAction,
} from "./channel-approval-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/**
 * Legacy actions that map to canonical ones during client rollout.
 * All temporal/persistent approval variants collapse to approve_once.
 * Keep until all clients are updated and no in-flight buttons remain.
 */
const LEGACY_ACTION_MAP: Record<string, string> = {
  approve_10m: "approve_once",
  approve_conversation: "approve_once",
  approve_always: "approve_once",
};

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface ProcessGuardianDecisionParams {
  requestId: string;
  action: string;
  conversationId?: string;
  channel: string; // e.g. "vellum"
  actorContext: {
    actorPrincipalId: string | undefined;
    guardianPrincipalId: string | undefined;
  };
}

export type ProcessGuardianDecisionResult =
  | { ok: true; applied: true; requestId: string; replyText?: string }
  | {
      ok: true;
      applied: false;
      reason: string;
      resolverFailureReason?: string;
      requestId?: string;
    }
  | { ok: false; error: "invalid_action" | "invalid_scope"; message: string };

// ---------------------------------------------------------------------------
// Core decision processing
// ---------------------------------------------------------------------------

/**
 * Process a guardian decision through the canonical request primitive.
 *
 * Validates the action, checks conversation scope if applicable, applies the
 * canonical decision, and maps the result to a caller-agnostic shape that
 * both HTTP and message handlers can interpret.
 *
 * Valid actions are the `ApprovalAction` union; the canonical primitive
 * additionally scopes the introduction-card actions to `access_request`
 * requests.
 */
export async function processGuardianDecision(
  params: ProcessGuardianDecisionParams,
): Promise<ProcessGuardianDecisionResult> {
  const { requestId, conversationId, channel, actorContext } = params;

  // 1. Canonicalize legacy actions, then validate
  const action = LEGACY_ACTION_MAP[params.action] ?? params.action;
  if (!isApprovalAction(action)) {
    return {
      ok: false,
      error: "invalid_action",
      message: `Invalid action: ${params.action}. Must be one of: ${APPROVAL_ACTION_IDS.join(", ")}`,
    };
  }

  // 2. Verify conversationId scoping before applying the canonical decision.
  //    The decision is allowed when the conversationId matches the request's
  //    source conversation OR a recorded delivery destination conversation.
  if (conversationId) {
    const canonicalRequest = getCanonicalGuardianRequest(requestId);
    if (
      canonicalRequest &&
      canonicalRequest.conversationId &&
      !isRequestInConversationScope(requestId, conversationId, channel)
    ) {
      return { ok: true, applied: false, reason: "not_found" };
    }
  }

  // 3. Apply the canonical decision
  const canonicalResult = await applyCanonicalGuardianDecision({
    requestId,
    action,
    actorContext: {
      actorPrincipalId: actorContext.actorPrincipalId,
      actorExternalUserId: undefined, // Desktop path — no channel-native ID
      channel,
      guardianPrincipalId: actorContext.guardianPrincipalId,
    },
    userText: undefined,
  });

  // 4. Map the canonical result
  if (canonicalResult.applied) {
    if (canonicalResult.resolverFailed) {
      return {
        ok: true,
        applied: false,
        reason: "resolver_failed",
        resolverFailureReason: canonicalResult.resolverFailureReason,
        requestId: canonicalResult.requestId,
      };
    }

    return {
      ok: true,
      applied: true,
      requestId: canonicalResult.requestId,
      replyText: canonicalResult.resolverReplyText,
    };
  }

  return {
    ok: true,
    applied: false,
    reason: canonicalResult.reason,
    requestId,
  };
}
