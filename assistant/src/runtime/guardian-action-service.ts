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
} from "../memory/canonical-guardian-store.js";
import type { ApprovalAction } from "./channel-approval-types.js";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Canonical set of valid guardian actions, shared across all entrypoints. */
const VALID_GUARDIAN_ACTIONS: ReadonlySet<string> = new Set<string>([
  "approve_once",
  "approve_10m",
  "approve_conversation",
  "approve_always",
  "reject",
]);

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
 */
export async function processGuardianDecision(
  params: ProcessGuardianDecisionParams,
): Promise<ProcessGuardianDecisionResult> {
  const { requestId, action, conversationId, channel, actorContext } = params;

  // 1. Validate action
  if (!VALID_GUARDIAN_ACTIONS.has(action)) {
    return {
      ok: false,
      error: "invalid_action",
      message: `Invalid action: ${action}. Must be one of: approve_once, approve_10m, approve_conversation, approve_always, reject`,
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
    action: action as ApprovalAction,
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
