/**
 * Shared guardian reply router for inbound channel messages.
 *
 * Provides a single entry point (`routeGuardianReply`) for all inbound
 * guardian reply processing across Telegram, SMS, and WhatsApp. Routes
 * through a priority-ordered pipeline:
 *
 *   1. Deterministic callback/ref parsing (button presses with `apr:<requestId>:<action>`)
 *   2. Request code parsing (6-char alphanumeric prefix matching)
 *   3. NL classification via the conversational approval engine
 *
 * All decisions flow through `applyCanonicalGuardianDecision` from M2,
 * which handles identity validation, expiry checks, CAS resolution,
 * kind-specific resolver dispatch, and grant minting.
 *
 * The router is intentionally kept separate from the inbound message handler
 * to allow for incremental migration and independent testability.
 */

import type { ApprovalAction } from './channel-approval-types.js';
import type {
  ApprovalConversationContext,
  ApprovalConversationGenerator,
} from './http-types.js';
import { runApprovalConversationTurn } from './approval-conversation-turn.js';
import {
  applyCanonicalGuardianDecision,
  type CanonicalDecisionResult,
} from '../approvals/guardian-decision-primitive.js';
import type { ActorContext } from '../approvals/guardian-request-resolvers.js';
import {
  getCanonicalGuardianRequest,
  getCanonicalGuardianRequestByCode,
  listCanonicalGuardianRequests,
  type CanonicalGuardianRequest,
} from '../memory/canonical-guardian-store.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('guardian-reply-router');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Context for an inbound message that may be a guardian reply. */
export interface GuardianReplyContext {
  /** The raw message text (trimmed). */
  messageText: string;
  /** Source channel (telegram, sms, whatsapp, etc.). */
  channel: string;
  /** Actor identity context for the sender. */
  actor: ActorContext;
  /** Conversation ID for this message (may be the guardian's conversation). */
  conversationId: string;
  /** Callback data from button presses (e.g. `apr:<requestId>:<action>`). */
  callbackData?: string;
  /** IDs of known pending canonical requests for this guardian. */
  pendingRequestIds?: string[];
  /** Conversation generator for NL classification (injected by daemon). */
  approvalConversationGenerator?: ApprovalConversationGenerator;
}

export type GuardianReplyResultType =
  | 'canonical_decision_applied'
  | 'canonical_decision_stale'
  | 'code_only_clarification'
  | 'disambiguation_needed'
  | 'nl_keep_pending'
  | 'not_consumed';

/** Result from the guardian reply router. */
export interface GuardianReplyResult {
  /** Whether a decision was applied to a canonical request. */
  decisionApplied: boolean;
  /** Reply text to send back to the guardian (if any). */
  replyText?: string;
  /** Whether the message was consumed and should not enter the agent pipeline. */
  consumed: boolean;
  /** The type of outcome for diagnostics. */
  type: GuardianReplyResultType;
  /** The canonical request ID that was targeted (if any). */
  requestId?: string;
  /** Detailed result from the canonical decision primitive (when a decision was attempted). */
  canonicalResult?: CanonicalDecisionResult;
}

// ---------------------------------------------------------------------------
// Callback data parser — format: "apr:<requestId>:<action>"
// ---------------------------------------------------------------------------

const VALID_ACTIONS: ReadonlySet<string> = new Set([
  'approve_once',
  'approve_always',
  'reject',
]);

interface ParsedCallback {
  requestId: string;
  action: ApprovalAction;
}

function parseCallbackAction(data: string): ParsedCallback | null {
  const parts = data.split(':');
  if (parts.length < 3 || parts[0] !== 'apr') return null;
  const requestId = parts[1];
  const action = parts.slice(2).join(':');
  if (!requestId || !VALID_ACTIONS.has(action)) return null;
  return { requestId, action: action as ApprovalAction };
}

// ---------------------------------------------------------------------------
// Request code parser
// ---------------------------------------------------------------------------

/**
 * 6-char alphanumeric request code at the start of a message.
 * Returns the matching canonical request and the remaining text after
 * the code prefix.
 *
 * When `scopeConversationId` is provided, the matched request must belong
 * to that conversation — otherwise the code is treated as unmatched so
 * that requests from other sessions are never accidentally consumed.
 */
interface CodeParseResult {
  request: CanonicalGuardianRequest;
  remainingText: string;
}

function parseRequestCode(text: string, scopeConversationId?: string): CodeParseResult | null {
  // Request codes are 6 hex chars (A-F, 0-9), uppercase
  const upper = text.toUpperCase();
  const match = upper.match(/^([A-F0-9]{6})(?:\s|$)/);
  if (!match) return null;

  const code = match[1];
  const request = getCanonicalGuardianRequestByCode(code);
  if (!request) return null;

  // Scope to the current conversation when requested, so a code belonging
  // to a different session/conversation is not consumed here. Requests with
  // null conversationId are global/unscoped and match any conversation.
  if (scopeConversationId && request.conversationId && request.conversationId !== scopeConversationId) {
    log.info(
      { event: 'router_code_conversation_mismatch', code, requestId: request.id, expected: scopeConversationId, actual: request.conversationId },
      'Request code matched a canonical request from a different conversation — ignoring',
    );
    return null;
  }

  const remainingText = text.slice(code.length).trim();
  return { request, remainingText };
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Find all pending canonical requests for a guardian actor. */
function findPendingCanonicalRequests(
  actor: ActorContext,
  pendingRequestIds?: string[],
): CanonicalGuardianRequest[] {
  // When explicit IDs are provided, look them up directly
  if (pendingRequestIds && pendingRequestIds.length > 0) {
    return pendingRequestIds
      .map(getCanonicalGuardianRequest)
      .filter((r): r is CanonicalGuardianRequest => r !== null && r.status === 'pending');
  }

  // Otherwise, query by guardian identity
  if (actor.externalUserId) {
    return listCanonicalGuardianRequests({
      status: 'pending',
      guardianExternalUserId: actor.externalUserId,
    });
  }

  return [];
}

/** Map an approval action string to the NL engine's allowed actions for guardians. */
function guardianAllowedActions(): ApprovalAction[] {
  return ['approve_once', 'reject'];
}

function notConsumed(): GuardianReplyResult {
  return { decisionApplied: false, consumed: false, type: 'not_consumed' };
}

// ---------------------------------------------------------------------------
// Core router
// ---------------------------------------------------------------------------

/**
 * Route an inbound guardian reply through the canonical decision pipeline.
 *
 * This is the single entry point for all inbound guardian reply processing.
 * It handles messages from any channel (Telegram, SMS, WhatsApp) and
 * routes through priority-ordered matching:
 *
 *   1. Deterministic callback parsing (button presses)
 *   2. Request code parsing (6-char alphanumeric prefix)
 *   3. NL classification via the conversational approval engine
 *
 * All decisions flow through `applyCanonicalGuardianDecision`.
 */
export async function routeGuardianReply(
  ctx: GuardianReplyContext,
): Promise<GuardianReplyResult> {
  const { messageText, channel, actor, conversationId, callbackData, approvalConversationGenerator } = ctx;

  // ── 1. Deterministic callback parsing (button presses) ──
  if (callbackData) {
    const parsed = parseCallbackAction(callbackData);
    if (parsed) {
      // When scoped to a conversation, verify the target request belongs to it
      // before applying the decision. This prevents button presses in one
      // session from resolving requests that belong to a different session.
      if (conversationId) {
        const targetRequest = getCanonicalGuardianRequest(parsed.requestId);
        if (targetRequest && targetRequest.conversationId && targetRequest.conversationId !== conversationId) {
          log.info(
            { event: 'router_callback_conversation_mismatch', requestId: parsed.requestId, expected: conversationId, actual: targetRequest.conversationId },
            'Callback target request belongs to a different conversation — ignoring',
          );
          return notConsumed();
        }
      }
      return applyDecision(parsed.requestId, parsed.action, actor);
    }
  }

  // ── 2. Request code parsing (6-char alphanumeric prefix) ──
  if (messageText.length > 0) {
    const codeResult = parseRequestCode(messageText, conversationId);
    if (codeResult) {
      const { request } = codeResult;

      if (request.status !== 'pending') {
        log.info(
          { event: 'router_code_already_resolved', requestId: request.id, status: request.status },
          'Request code matched a non-pending canonical request',
        );
        return {
          decisionApplied: false,
          consumed: true,
          type: 'canonical_decision_stale',
          requestId: request.id,
          replyText: failureReplyText('already_resolved', request.requestCode),
        };
      }

      // Code-only messages (no decision text after the code) are treated as
      // clarification inquiries — the guardian may be asking "what is this?"
      // rather than intending to approve. Return helpful context instead of
      // silently defaulting to approve_once.
      if (!codeResult.remainingText || codeResult.remainingText.trim().length === 0) {
        // Identity check: only expose request details to the assigned guardian
        // or trusted (desktop) actors. Mirrors the identity check in
        // applyCanonicalGuardianDecision to prevent leaking request details
        // (toolName, questionText) to unauthorized senders.
        if (
          request.guardianExternalUserId &&
          !actor.isTrusted &&
          actor.externalUserId !== request.guardianExternalUserId
        ) {
          log.warn(
            {
              event: 'router_code_only_identity_mismatch',
              requestId: request.id,
              expectedGuardian: request.guardianExternalUserId,
              actualActor: actor.externalUserId,
            },
            'Code-only clarification blocked: actor identity does not match expected guardian',
          );
          return {
            decisionApplied: false,
            consumed: true,
            type: 'code_only_clarification',
            requestId: request.id,
            replyText: 'Request not found.',
          };
        }

        log.info(
          { event: 'router_code_only_clarification', requestId: request.id, code: request.requestCode },
          'Code-only message treated as clarification inquiry',
        );
        return {
          decisionApplied: false,
          consumed: true,
          type: 'code_only_clarification',
          requestId: request.id,
          replyText: composeCodeOnlyClarification(request),
        };
      }

      // Remaining text present — infer the decision action from it.
      // If the text indicates rejection, use reject; otherwise approve_once.
      const action = inferActionFromText(codeResult.remainingText);

      return applyDecision(request.id, action, actor, codeResult.remainingText);
    }
  }

  // ── 3. NL classification via the conversational approval engine ──
  if (messageText.length > 0 && approvalConversationGenerator) {
    const allPendingRequests = findPendingCanonicalRequests(actor, ctx.pendingRequestIds);

    if (allPendingRequests.length === 0) {
      return notConsumed();
    }

    // Scope pending requests to the current conversation so disambiguation
    // only shows requests that can actually be resolved from this thread.
    // Requests without a conversationId are included as they may be global.
    const pendingRequests = conversationId
      ? allPendingRequests.filter(r => !r.conversationId || r.conversationId === conversationId)
      : allPendingRequests;

    if (pendingRequests.length === 0) {
      log.info(
        { event: 'router_nl_no_conversation_requests', conversationId, totalPending: allPendingRequests.length },
        'No pending requests match the current conversation',
      );
      return {
        decisionApplied: false,
        consumed: false,
        type: 'not_consumed',
        replyText: 'No pending requests in this conversation.',
      };
    }

    // Build the conversation context for the NL engine
    const engineContext: ApprovalConversationContext = {
      toolName: pendingRequests[0].toolName ?? 'unknown',
      allowedActions: guardianAllowedActions(),
      role: 'guardian',
      pendingApprovals: pendingRequests.map(r => ({
        requestId: r.id,
        toolName: r.toolName ?? 'unknown',
      })),
      userMessage: messageText,
    };

    const engineResult = await runApprovalConversationTurn(
      engineContext,
      approvalConversationGenerator,
    );

    if (engineResult.disposition === 'keep_pending') {
      // When the engine returns keep_pending with multiple pending requests,
      // this likely means the NL classification understood a decision intent
      // but runApprovalConversationTurn fail-closed because no targetRequestId
      // was provided. In this case, produce a disambiguation reply instead of
      // a generic "I couldn't process that" message.
      if (pendingRequests.length > 1) {
        log.info(
          { event: 'router_nl_disambiguation_needed', pendingCount: pendingRequests.length },
          'Engine returned keep_pending with multiple pending requests — producing disambiguation',
        );
        const disambiguationReply = composeDisambiguationReply(pendingRequests, undefined);
        return {
          decisionApplied: false,
          consumed: true,
          type: 'disambiguation_needed',
          replyText: disambiguationReply,
        };
      }
      return {
        decisionApplied: false,
        replyText: engineResult.replyText,
        consumed: true,
        type: 'nl_keep_pending',
      };
    }

    // Decision-bearing disposition from the engine
    let decisionAction = engineResult.disposition as ApprovalAction;

    // Guardians cannot approve_always — the canonical primitive enforces
    // this too, but enforce it here for clarity.
    if (decisionAction === 'approve_always') {
      decisionAction = 'approve_once';
    }

    // Resolve the target request
    const targetId = engineResult.targetRequestId ?? (pendingRequests.length === 1 ? pendingRequests[0].id : undefined);

    if (!targetId) {
      // Multi-pending and engine didn't pick a target — need disambiguation.
      // Fail-closed: never auto-resolve when the target is ambiguous.
      log.info(
        { event: 'router_nl_disambiguation_needed', pendingCount: pendingRequests.length },
        'NL engine returned a decision but no target for multi-pending requests',
      );
      const disambiguationReply = composeDisambiguationReply(pendingRequests, engineResult.replyText);
      return {
        decisionApplied: false,
        consumed: true,
        type: 'disambiguation_needed',
        replyText: disambiguationReply,
      };
    }

    const result = await applyDecision(targetId, decisionAction, actor, messageText);

    // Always attach the engine's reply text so the guardian gets feedback
    // even when the decision was not applied (stale, expired, identity mismatch).
    if (engineResult.replyText) {
      result.replyText = engineResult.replyText;
    }

    return result;
  }

  // No matching strategy and no engine — not consumed
  return notConsumed();
}

// ---------------------------------------------------------------------------
// Decision application
// ---------------------------------------------------------------------------

/**
 * Apply a decision to a canonical request through the unified primitive.
 */
async function applyDecision(
  requestId: string,
  action: ApprovalAction,
  actor: ActorContext,
  userText?: string,
): Promise<GuardianReplyResult> {
  const canonicalResult = await applyCanonicalGuardianDecision({
    requestId,
    action,
    actorContext: actor,
    userText,
  });

  if (canonicalResult.applied) {
    log.info(
      {
        event: 'router_decision_applied',
        requestId,
        action,
        grantMinted: canonicalResult.grantMinted,
        resolverFailed: canonicalResult.resolverFailed,
      },
      'Guardian reply router applied canonical decision',
    );

    return {
      decisionApplied: true,
      consumed: true,
      type: 'canonical_decision_applied',
      requestId,
      canonicalResult,
    };
  }

  log.info(
    {
      event: 'router_decision_not_applied',
      requestId,
      action,
      reason: canonicalResult.reason,
    },
    `Guardian reply router: canonical decision not applied (${canonicalResult.reason})`,
  );

  // When the canonical request doesn't exist, allow the message to fall
  // through so the legacy handleApprovalInterception handler can process it.
  if (canonicalResult.reason === 'not_found') {
    return notConsumed();
  }

  return {
    decisionApplied: false,
    consumed: true,
    type: 'canonical_decision_stale',
    requestId,
    canonicalResult,
    replyText: failureReplyText(canonicalResult.reason),
  };
}

// ---------------------------------------------------------------------------
// Text-to-action inference
// ---------------------------------------------------------------------------

const REJECT_PATTERNS = /^(no|deny|reject|decline|cancel|block)\b/i;

/**
 * Infer a guardian decision action from free-text after a request code.
 * Defaults to approve_once unless clear rejection language is detected.
 */
function inferActionFromText(text: string): ApprovalAction {
  if (!text || text.trim().length === 0) {
    return 'approve_once';
  }

  if (REJECT_PATTERNS.test(text.trim())) {
    return 'reject';
  }

  return 'approve_once';
}

// ---------------------------------------------------------------------------
// Failure reason reply text
// ---------------------------------------------------------------------------

type CanonicalFailureReason = 'already_resolved' | 'identity_mismatch' | 'invalid_action' | 'expired';

/**
 * Map a canonical decision failure reason to a distinct, actionable reply
 * so the guardian understands exactly what happened and what to do next.
 */
function failureReplyText(reason: CanonicalFailureReason, requestCode?: string | null): string {
  switch (reason) {
    case 'already_resolved':
      return 'This request has already been resolved.';
    case 'expired':
      return 'This request has expired.';
    case 'identity_mismatch':
      return "You don't have permission to decide on this request.";
    case 'invalid_action':
      return requestCode
        ? `I found request ${requestCode}, but I need to know your decision. Reply "${requestCode} approve" or "${requestCode} reject".`
        : "I couldn't determine your intended action. Reply with the request code followed by 'approve' or 'reject' (e.g., \"ABC123 approve\").";
    default:
      return "I couldn't process that request. Please try again.";
  }
}

// ---------------------------------------------------------------------------
// Code-only clarification
// ---------------------------------------------------------------------------

/**
 * Compose a clarification response when a guardian sends only a request
 * code without any decision text. Provides context about the request and
 * tells the guardian how to approve or reject it.
 */
function composeCodeOnlyClarification(request: CanonicalGuardianRequest): string {
  const code = request.requestCode ?? 'unknown';
  const toolLabel = request.toolName ?? 'an action';
  const lines: string[] = [
    `I found request ${code} for ${toolLabel}.`,
  ];
  if (request.questionText) {
    lines.push(`Details: ${request.questionText}`);
  }
  lines.push(`Reply "${code} approve" to approve or "${code} reject" to reject.`);
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Disambiguation reply
// ---------------------------------------------------------------------------

/**
 * Compose a disambiguation reply that includes concrete decision examples
 * using actual request codes from the pending requests. Always includes
 * explicit instructions so the guardian knows exactly how to proceed.
 */
function composeDisambiguationReply(
  pendingRequests: CanonicalGuardianRequest[],
  engineReplyText?: string,
): string {
  const lines: string[] = [];

  if (engineReplyText) {
    lines.push(engineReplyText);
    lines.push('');
  }

  lines.push(`You have ${pendingRequests.length} pending requests. Please specify which one:`);

  for (const req of pendingRequests) {
    const toolLabel = req.toolName ?? 'action';
    const code = req.requestCode ?? req.id.slice(0, 6).toUpperCase();
    lines.push(`  - ${code}: ${toolLabel}`);
  }

  // Include a concrete example using the first request's code
  const exampleCode = pendingRequests[0].requestCode ?? pendingRequests[0].id.slice(0, 6).toUpperCase();
  lines.push('');
  lines.push(`Reply "${exampleCode} approve" to approve a specific request.`);

  return lines.join('\n');
}
