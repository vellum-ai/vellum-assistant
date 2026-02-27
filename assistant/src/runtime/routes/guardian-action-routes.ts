/**
 * Route handlers for deterministic guardian action endpoints.
 *
 * These endpoints let desktop clients fetch pending guardian prompts and
 * submit button decisions without relying on text parsing.
 */
import {
  getGuardianActionRequest,
  getPendingDeliveriesByConversation,
} from '../../memory/guardian-action-store.js';
import {
  getPendingApprovalForRequest,
  listPendingApprovalRequests,
} from '../../memory/channel-guardian-store.js';
import { applyGuardianDecision } from '../../approvals/guardian-decision-primitive.js';
import type { GuardianDecisionPrompt } from '../guardian-decision-types.js';
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
  return Response.json({ prompts });
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

  // Fall back to the pending interactions tracker (direct confirmation requests)
  const interaction = pendingInteractions.get(requestId);
  if (interaction) {
    const decision = action === 'reject' ? 'deny' : 'allow';
    const resolved = pendingInteractions.resolve(requestId);
    if (!resolved) {
      return Response.json({ applied: false, reason: 'stale' });
    }
    resolved.session.handleConfirmationResponse(requestId, decision);
    return Response.json({ applied: true, requestId });
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
      actions: [
        { action: 'approve_once', label: 'Approve once' },
        { action: 'reject', label: 'Reject' },
      ],
      expiresAt: approval.expiresAt,
      conversationId: approval.conversationId,
      callSessionId: null,
    });
  }

  // 2. Guardian action requests (voice call guardian questions delivered to this conversation)
  const actionDeliveries = getPendingDeliveriesByConversation(conversationId);
  for (const delivery of actionDeliveries) {
    const actionReq = getGuardianActionRequest(delivery.requestId);
    if (!actionReq || actionReq.status !== 'pending') continue;

    prompts.push({
      requestId: actionReq.id,
      requestCode: actionReq.requestCode,
      state: 'pending',
      questionText: actionReq.questionText,
      toolName: actionReq.toolName,
      actions: [
        { action: 'approve_once', label: 'Approve' },
        { action: 'reject', label: 'Reject' },
      ],
      expiresAt: actionReq.expiresAt,
      conversationId,
      callSessionId: actionReq.callSessionId,
    });
  }

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
      actions: [
        { action: 'approve_once', label: 'Approve once' },
        { action: 'approve_always', label: 'Approve always' },
        { action: 'reject', label: 'Reject' },
      ],
      expiresAt: Date.now() + 300_000,
      conversationId,
      callSessionId: null,
    });
  }

  return prompts;
}
