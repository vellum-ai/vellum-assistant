/**
 * Route handlers for deterministic guardian action endpoints.
 *
 * These endpoints let desktop clients fetch pending guardian prompts and
 * submit button decisions without relying on text parsing.
 */
import {
  getPendingApprovalForRequest,
  listPendingApprovalRequests,
} from '../../memory/channel-guardian-store.js';
import { applyGuardianDecision } from '../../approvals/guardian-decision-primitive.js';
import { handleChannelDecision } from '../channel-approvals.js';
import type { ApprovalAction } from '../channel-approval-types.js';
import type { GuardianDecisionPrompt } from '../guardian-decision-types.js';
import { buildDecisionActions } from '../guardian-decision-types.js';
import { httpError } from '../http-errors.js';
import * as pendingInteractions from '../pending-interactions.js';

// ---------------------------------------------------------------------------
// GET /v1/guardian-actions/pending?conversationId=...
// ---------------------------------------------------------------------------

/**
 * List pending guardian decision prompts for a conversation.
 *
 * Returns guardian approval requests (from the channel guardian store) that
 * are still pending, mapped to the GuardianDecisionPrompt shape so clients
 * can render structured button UIs.
 */
export function handleGuardianActionsPending(req: Request): Response {
  const url = new URL(req.url);
  const conversationId = url.searchParams.get('conversationId');

  if (!conversationId) {
    return httpError('BAD_REQUEST', 'conversationId query parameter is required', 400);
  }

  const prompts = listGuardianDecisionPrompts({ conversationId });
  return Response.json({ conversationId, prompts });
}

// ---------------------------------------------------------------------------
// POST /v1/guardian-actions/decision
// ---------------------------------------------------------------------------

/**
 * Submit a guardian action decision.
 *
 * Looks up the guardian approval by requestId and applies the decision
 * through the unified guardian decision primitive.
 */
export async function handleGuardianActionDecision(req: Request): Promise<Response> {
  const body = await req.json() as {
    requestId?: string;
    action?: string;
    conversationId?: string;
  };

  const { requestId, action, conversationId } = body;

  if (!requestId || typeof requestId !== 'string') {
    return httpError('BAD_REQUEST', 'requestId is required', 400);
  }

  if (!action || typeof action !== 'string') {
    return httpError('BAD_REQUEST', 'action is required', 400);
  }

  const VALID_ACTIONS = new Set<string>(['approve_once', 'approve_always', 'reject']);
  if (!VALID_ACTIONS.has(action)) {
    return httpError('BAD_REQUEST', `Invalid action: ${action}. Must be one of: approve_once, approve_always, reject`, 400);
  }

  // Try the channel guardian approval store first (tool approval prompts)
  const approval = getPendingApprovalForRequest(requestId);
  if (approval) {
    const result = applyGuardianDecision({
      approval,
      decision: { action: action as 'approve_once' | 'approve_always' | 'reject', source: 'plain_text', requestId },
      actorExternalUserId: undefined,
      actorChannel: 'vellum',
    });
    return Response.json(result);
  }

  // Fall back to the pending interactions tracker (direct confirmation requests).
  // Route through handleChannelDecision so approve_always properly persists trust rules.
  const interaction = pendingInteractions.get(requestId);
  if (interaction) {
    const result = handleChannelDecision(
      interaction.conversationId,
      { action: action as ApprovalAction, source: 'plain_text', requestId },
    );
    return Response.json(result);
  }

  return httpError('NOT_FOUND', 'No pending guardian action found for this requestId', 404);
}

// ---------------------------------------------------------------------------
// Shared helper: list guardian decision prompts
// ---------------------------------------------------------------------------

/**
 * Build a list of GuardianDecisionPrompt objects for the given conversation.
 *
 * Aggregates pending guardian approval requests from the channel guardian
 * store and pending confirmation interactions from the pending-interactions
 * tracker, exposing them in a uniform shape that clients can render as
 * structured button UIs.
 */
export function listGuardianDecisionPrompts(params: {
  conversationId: string;
}): GuardianDecisionPrompt[] {
  const { conversationId } = params;
  const prompts: GuardianDecisionPrompt[] = [];

  // 1. Channel guardian approval requests (tool approvals routed to guardians)
  const approvalRequests = listPendingApprovalRequests({
    conversationId,
    status: 'pending',
  });

  for (const approval of approvalRequests) {
    const reqId = approval.requestId ?? approval.id;
    prompts.push({
      requestId: reqId,
      requestCode: reqId.slice(0, 6).toUpperCase(),
      state: 'pending',
      questionText: approval.reason ?? `Approve tool: ${approval.toolName ?? 'unknown'}`,
      toolName: approval.toolName ?? null,
      actions: buildDecisionActions({ forGuardianOnBehalf: true }),
      expiresAt: approval.expiresAt,
      conversationId: approval.conversationId,
      callSessionId: null,
    });
  }

  // 2. Guardian action requests (voice call guardian questions) are intentionally
  // excluded here — resolving them requires the answerCall + resolveGuardianActionRequest
  // flow which is handled by the conversational session-process path, not by the
  // deterministic button decision endpoint.

  // 3. Pending confirmation interactions (direct tool approval prompts)
  const interactions = pendingInteractions.getByConversation(conversationId);
  for (const interaction of interactions) {
    if (interaction.kind !== 'confirmation' || !interaction.confirmationDetails) continue;
    // Skip if already covered by a channel guardian approval above
    if (prompts.some(p => p.requestId === interaction.requestId)) continue;

    const details = interaction.confirmationDetails;
    prompts.push({
      requestId: interaction.requestId,
      requestCode: interaction.requestId.slice(0, 6).toUpperCase(),
      state: 'pending',
      questionText: `Approve tool: ${details.toolName}`,
      toolName: details.toolName,
      actions: buildDecisionActions({
        persistentDecisionsAllowed: details.persistentDecisionsAllowed,
      }),
      expiresAt: Date.now() + 300_000,
      conversationId,
      callSessionId: null,
    });
  }

  return prompts;
}
