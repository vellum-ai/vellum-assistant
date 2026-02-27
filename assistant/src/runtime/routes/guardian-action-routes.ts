/**
 * Route handlers for deterministic guardian action endpoints.
 *
 * These endpoints let desktop clients fetch pending guardian prompts and
 * submit button decisions without relying on text parsing.
 */
import {
  applyCanonicalGuardianDecision,
  applyGuardianDecision,
} from '../../approvals/guardian-decision-primitive.js';
import {
  getPendingApprovalForRequest,
  listPendingApprovalRequests,
} from '../../memory/channel-guardian-store.js';
import {
  getCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
  type CanonicalGuardianRequest,
} from '../../memory/canonical-guardian-store.js';
import type { ApprovalAction } from '../channel-approval-types.js';
import { handleChannelDecision } from '../channel-approvals.js';
import type { GuardianDecisionPrompt } from '../guardian-decision-types.js';
import { buildDecisionActions } from '../guardian-decision-types.js';
import { httpError } from '../http-errors.js';
import * as pendingInteractions from '../pending-interactions.js';
import { handleAccessRequestDecision } from './access-request-decision.js';

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

  // ── Canonical-first: try the unified canonical guardian decision primitive ──
  // This is the future single write path. When the canonical request exists,
  // it handles CAS resolution, resolver dispatch, and grant minting.

  // Verify conversationId scoping before applying the canonical decision.
  // A caller must not be able to cross-resolve requests from a different conversation.
  if (conversationId) {
    const canonicalRequest = getCanonicalGuardianRequest(requestId);
    if (canonicalRequest && canonicalRequest.conversationId && canonicalRequest.conversationId !== conversationId) {
      // conversationId mismatch — treat as not found so we fall through to legacy
      // (which will also fail to match, resulting in a 404).
      return httpError('NOT_FOUND', 'No pending guardian action found for this requestId', 404);
    }
  }

  const canonicalResult = await applyCanonicalGuardianDecision({
    requestId,
    action: action as ApprovalAction,
    actorContext: {
      externalUserId: undefined,
      channel: 'vellum',
      isTrusted: true,
    },
    userText: undefined,
  });

  if (canonicalResult.applied) {
    return Response.json({
      applied: true,
      requestId: canonicalResult.requestId,
    });
  }

  // If the canonical request was found but couldn't be applied (stale, expired, etc.),
  // return the reason rather than falling through to legacy.
  if (canonicalResult.applied === false && canonicalResult.reason !== 'not_found') {
    return Response.json({
      applied: false,
      reason: canonicalResult.reason,
      requestId,
    });
  }

  // ── Legacy fallback: canonical request not found, try legacy stores ──

  // Try the channel guardian approval store (tool approval prompts)
  const approval = getPendingApprovalForRequest(requestId);
  if (approval) {
    // Enforce conversationId scoping: reject decisions that target the wrong conversation.
    if (conversationId && conversationId !== approval.conversationId) {
      return httpError('BAD_REQUEST', 'conversationId does not match the approval', 400);
    }

    // Access request approvals need a separate decision path — they don't have
    // pending interactions and use verification sessions instead.
    if (approval.toolName === 'ingress_access_request') {
      const mappedAction = action === 'reject' ? 'deny' as const : 'approve' as const;
      // Use 'desktop' as the actor identity because this endpoint is
      // unauthenticated — we cannot verify the caller is the assigned
      // guardian, so we record a generic desktop origin instead of
      // falsely attributing the decision to guardianExternalUserId.
      const decisionResult = handleAccessRequestDecision(
        approval,
        mappedAction,
        'desktop',
      );
      return Response.json({
        applied: decisionResult.type !== 'stale',
        requestId,
        reason: decisionResult.type === 'stale' ? 'stale' : undefined,
        accessRequestResult: decisionResult,
      });
    }

    // Note: actorExternalUserId is left undefined because the desktop endpoint
    // does not authenticate caller identity. This means scoped grant minting is
    // skipped for button-based decisions — an acceptable trade-off to avoid
    // falsifying audit records with an unverified guardian identity.
    const result = applyGuardianDecision({
      approval,
      decision: { action: action as 'approve_once' | 'approve_always' | 'reject', source: 'plain_text', requestId },
      actorExternalUserId: undefined,
      actorChannel: 'vellum',
    });
    return Response.json({ ...result, requestId: result.requestId ?? requestId });
  }

  // Fall back to the pending interactions tracker (direct confirmation requests).
  // Route through handleChannelDecision so approve_always properly persists trust rules.
  const interaction = pendingInteractions.get(requestId);
  if (interaction) {
    // Enforce conversationId scoping for interactions too.
    if (conversationId && conversationId !== interaction.conversationId) {
      return httpError('BAD_REQUEST', 'conversationId does not match the interaction', 400);
    }

    const result = handleChannelDecision(
      interaction.conversationId,
      { action: action as ApprovalAction, source: 'plain_text', requestId },
    );
    return Response.json({ ...result, requestId: result.requestId ?? requestId });
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

  // Track IDs we've already added so we don't produce duplicates when the
  // same request appears in both canonical and legacy stores during dual-read.
  const seenRequestIds = new Set<string>();

  // 1. Canonical guardian requests — the unified cross-source domain.
  // Includes all request types (tool_approval, pending_question, etc.).
  const canonicalRequests = listCanonicalGuardianRequests({
    conversationId,
    status: 'pending',
  });

  for (const req of canonicalRequests) {
    // Skip expired canonical requests
    if (req.expiresAt && new Date(req.expiresAt).getTime() < Date.now()) continue;

    const prompt = mapCanonicalRequestToPrompt(req, conversationId);
    prompts.push(prompt);
    seenRequestIds.add(req.id);
  }

  // 2. Legacy: channel guardian approval requests (tool approvals routed to guardians)
  const approvalRequests = listPendingApprovalRequests({
    conversationId,
    status: 'pending',
  }).filter(a => a.expiresAt > Date.now() && a.requestId != null);

  for (const approval of approvalRequests) {
    const reqId = approval.requestId!;
    if (seenRequestIds.has(reqId)) continue;

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
    seenRequestIds.add(reqId);
  }

  // 3. Legacy: pending confirmation interactions (direct tool approval prompts)
  const interactions = pendingInteractions.getByConversation(conversationId);
  for (const interaction of interactions) {
    if (interaction.kind !== 'confirmation' || !interaction.confirmationDetails) continue;
    if (seenRequestIds.has(interaction.requestId)) continue;

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
    seenRequestIds.add(interaction.requestId);
  }

  return prompts;
}

// ---------------------------------------------------------------------------
// Canonical request -> prompt mapping
// ---------------------------------------------------------------------------

/**
 * Map a canonical guardian request to the client-facing prompt format.
 *
 * Generates an appropriate questionText based on the request kind, and
 * determines which actions are available. Pending questions surface as
 * informational prompts since they may require text input rather than
 * simple approve/reject buttons.
 */
function mapCanonicalRequestToPrompt(
  req: CanonicalGuardianRequest,
  conversationId: string,
): GuardianDecisionPrompt {
  const questionText = req.questionText
    ?? (req.toolName ? `Approve tool: ${req.toolName}` : `Guardian request: ${req.kind}`);

  // pending_question requests are typically voice-originated and need
  // approve/reject only (no approve_always — guardian-on-behalf invariant).
  const actions = buildDecisionActions({ forGuardianOnBehalf: true });

  const expiresAt = req.expiresAt
    ? new Date(req.expiresAt).getTime()
    : Date.now() + 300_000;

  return {
    requestId: req.id,
    requestCode: req.requestCode ?? req.id.slice(0, 6).toUpperCase(),
    state: 'pending',
    questionText,
    toolName: req.toolName ?? null,
    actions,
    expiresAt,
    conversationId: req.conversationId ?? conversationId,
    callSessionId: req.callSessionId ?? null,
    kind: req.kind,
  };
}
