/**
 * Route handlers for deterministic guardian action endpoints.
 *
 * These endpoints let desktop clients fetch pending guardian prompts and
 * submit button decisions without relying on text parsing.
 *
 * All guardian action endpoints require a valid actor token via the
 * X-Actor-Token header (with local CLI fallback). Guardian decisions
 * additionally verify the actor is the bound guardian.
 */
import {
  applyCanonicalGuardianDecision,
} from '../../approvals/guardian-decision-primitive.js';
import {
  type CanonicalGuardianRequest,
  getCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
} from '../../memory/canonical-guardian-store.js';
import type { ApprovalAction } from '../channel-approval-types.js';
import type { GuardianDecisionPrompt } from '../guardian-decision-types.js';
import { buildDecisionActions } from '../guardian-decision-types.js';
import { httpError } from '../http-errors.js';
import {
  isActorBoundGuardian,
  isLocalFallbackBoundGuardian,
  type ServerWithRequestIP,
  verifyHttpActorTokenWithLocalFallback,
} from '../middleware/actor-token.js';

// ---------------------------------------------------------------------------
// GET /v1/guardian-actions/pending?conversationId=...
// ---------------------------------------------------------------------------

/**
 * List pending guardian decision prompts for a conversation.
 * Requires a valid actor token.
 *
 * Returns guardian approval requests (from the channel guardian store) that
 * are still pending, mapped to the GuardianDecisionPrompt shape so clients
 * can render structured button UIs.
 */
export function handleGuardianActionsPending(req: Request, server: ServerWithRequestIP): Response {
  const tokenResult = verifyHttpActorTokenWithLocalFallback(req, server);
  if (!tokenResult.ok) {
    return httpError(
      tokenResult.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
      tokenResult.message,
      tokenResult.status,
    );
  }

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
 * Requires a valid actor token for a bound guardian.
 *
 * Routes all decisions through the unified canonical guardian decision
 * primitive which handles CAS resolution, resolver dispatch, and grant
 * minting.
 */
export async function handleGuardianActionDecision(req: Request, server: ServerWithRequestIP): Promise<Response> {
  const tokenResult = verifyHttpActorTokenWithLocalFallback(req, server);
  if (!tokenResult.ok) {
    return httpError(
      tokenResult.status === 401 ? 'UNAUTHORIZED' : 'FORBIDDEN',
      tokenResult.message,
      tokenResult.status,
    );
  }
  const isBoundGuardian = tokenResult.claims
    ? isActorBoundGuardian(tokenResult.claims)
    : isLocalFallbackBoundGuardian();
  if (!isBoundGuardian) {
    return httpError('FORBIDDEN', 'Actor is not the bound guardian for this channel', 403);
  }

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

  // Verify conversationId scoping before applying the canonical decision.
  // A caller must not be able to cross-resolve requests from a different conversation.
  if (conversationId) {
    const canonicalRequest = getCanonicalGuardianRequest(requestId);
    if (canonicalRequest && canonicalRequest.conversationId && canonicalRequest.conversationId !== conversationId) {
      return httpError('NOT_FOUND', 'No pending guardian action found for this requestId', 404);
    }
  }

  // Resolve the actor's external user ID: from the token claims if present,
  // otherwise from the vellum guardian binding (local fallback).
  const actorExternalUserId = tokenResult.claims
    ? tokenResult.claims.guardianPrincipalId
    : tokenResult.guardianContext.guardianExternalUserId;

  // Resolve the actor's principal ID: from the token claims if present,
  // otherwise from the vellum guardian binding (local fallback).
  const actorPrincipalId = tokenResult.claims
    ? tokenResult.claims.guardianPrincipalId
    : tokenResult.guardianContext.guardianPrincipalId ?? undefined;

  const canonicalResult = await applyCanonicalGuardianDecision({
    requestId,
    action: action as ApprovalAction,
    actorContext: {
      externalUserId: actorExternalUserId,
      channel: 'vellum',
      guardianPrincipalId: actorPrincipalId,
    },
    userText: undefined,
  });

  if (canonicalResult.applied) {
    // When the CAS committed but the resolver failed, the side effect
    // (e.g. minting a verification session) did not happen. From the
    // caller's perspective the decision was not truly applied.
    if (canonicalResult.resolverFailed) {
      return Response.json({
        applied: false,
        reason: 'resolver_failed',
        resolverFailureReason: canonicalResult.resolverFailureReason,
        requestId: canonicalResult.requestId,
      });
    }

    return Response.json({
      applied: true,
      requestId: canonicalResult.requestId,
    });
  }

  // Return the reason for failure (stale, expired, not_found, etc.)
  return canonicalResult.reason === 'not_found'
    ? httpError('NOT_FOUND', 'No pending guardian action found for this requestId', 404)
    : Response.json({
        applied: false,
        reason: canonicalResult.reason,
        requestId,
      });
}

// ---------------------------------------------------------------------------
// Shared helper: list guardian decision prompts
// ---------------------------------------------------------------------------

/**
 * Build a list of GuardianDecisionPrompt objects for the given conversation.
 *
 * Reads exclusively from the canonical guardian requests store. All request
 * kinds (tool_approval, pending_question, access_request, etc.) that have
 * been created as canonical requests will appear here.
 */
export function listGuardianDecisionPrompts(params: {
  conversationId: string;
}): GuardianDecisionPrompt[] {
  const { conversationId } = params;
  const prompts: GuardianDecisionPrompt[] = [];

  const canonicalRequests = listCanonicalGuardianRequests({
    conversationId,
    status: 'pending',
  });

  for (const req of canonicalRequests) {
    // Skip expired canonical requests
    if (req.expiresAt && new Date(req.expiresAt).getTime() < Date.now()) continue;

    const prompt = mapCanonicalRequestToPrompt(req, conversationId);
    prompts.push(prompt);
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
