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
 */
interface CodeParseResult {
  request: CanonicalGuardianRequest;
  remainingText: string;
}

function parseRequestCode(text: string): CodeParseResult | null {
  // Request codes are 6 hex chars (A-F, 0-9), uppercase
  const upper = text.toUpperCase();
  const match = upper.match(/^([A-F0-9]{6})(?:\s|$)/);
  if (!match) return null;

  const code = match[1];
  const request = getCanonicalGuardianRequestByCode(code);
  if (!request) return null;

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
  const { messageText, channel, actor, callbackData, approvalConversationGenerator } = ctx;

  // ── 1. Deterministic callback parsing (button presses) ──
  if (callbackData) {
    const parsed = parseCallbackAction(callbackData);
    if (parsed) {
      return applyDecision(parsed.requestId, parsed.action, actor);
    }
  }

  // ── 2. Request code parsing (6-char alphanumeric prefix) ──
  if (messageText.length > 0) {
    const codeResult = parseRequestCode(messageText);
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
        };
      }

      // For request codes, default to approve_once (guardian is answering).
      // If the remaining text indicates rejection, use reject instead.
      const action = inferActionFromText(codeResult.remainingText);

      return applyDecision(request.id, action, actor, codeResult.remainingText);
    }
  }

  // ── 3. NL classification via the conversational approval engine ──
  if (messageText.length > 0 && approvalConversationGenerator) {
    const pendingRequests = findPendingCanonicalRequests(actor, ctx.pendingRequestIds);

    if (pendingRequests.length === 0) {
      return notConsumed();
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
      // Multi-pending and engine didn't pick a target — need disambiguation
      log.info(
        { event: 'router_nl_disambiguation_needed', pendingCount: pendingRequests.length },
        'NL engine returned a decision but no target for multi-pending requests',
      );
      return {
        decisionApplied: false,
        consumed: true,
        type: 'disambiguation_needed',
        replyText: engineResult.replyText,
      };
    }

    const result = await applyDecision(targetId, decisionAction, actor, messageText);

    // If the canonical decision was applied, include the engine's reply text
    if (result.decisionApplied && engineResult.replyText) {
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

  return {
    decisionApplied: false,
    consumed: true,
    type: 'canonical_decision_stale',
    requestId,
    canonicalResult,
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
