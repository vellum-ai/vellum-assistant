/**
 * Route handlers for deterministic guardian action endpoints.
 *
 * These endpoints let desktop clients fetch pending guardian prompts and
 * submit button decisions without relying on text parsing.
 *
 * All guardian action endpoints require a valid JWT bearer token.
 * Auth is verified upstream by JWT middleware; the AuthContext is
 * threaded through from the HTTP server layer.
 *
 * Guardian decisions additionally verify the actor is the bound guardian
 * via the AuthContext's actorPrincipalId.
 */
import {
  applyCanonicalGuardianDecision,
} from '../../approvals/guardian-decision-primitive.js';
import { isHttpAuthDisabled } from '../../config/env.js';
import {
  type CanonicalGuardianRequest,
  getCanonicalGuardianRequest,
  isRequestInConversationScope,
  listPendingRequestsByConversationScope,
} from '../../memory/canonical-guardian-store.js';
import { getActiveBinding } from '../../memory/guardian-bindings.js';
import { DAEMON_INTERNAL_ASSISTANT_ID } from '../assistant-scope.js';
import type { AuthContext } from '../auth/types.js';
import type { ApprovalAction } from '../channel-approval-types.js';
import type { GuardianDecisionPrompt } from '../guardian-decision-types.js';
import { buildDecisionActions } from '../guardian-decision-types.js';
import { httpError } from '../http-errors.js';

// ---------------------------------------------------------------------------
// GET /v1/guardian-actions/pending?conversationId=...
// ---------------------------------------------------------------------------

/**
 * List pending guardian decision prompts for a conversation.
 * Auth is verified upstream by JWT middleware.
 *
 * Returns guardian approval requests (from the channel guardian store) that
 * are still pending, mapped to the GuardianDecisionPrompt shape so clients
 * can render structured button UIs.
 */
export function handleGuardianActionsPending(url: URL, _authContext: AuthContext): Response {
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
 * Verify that the actor from AuthContext is the bound guardian for the
 * vellum channel. Returns an error Response if not, or null if allowed.
 */
function requireBoundGuardian(authContext: AuthContext): Response | null {
  // Dev bypass: when auth is disabled, skip guardian binding check
  // (mirrors enforcePolicy dev bypass in route-policy.ts)
  if (isHttpAuthDisabled()) {
    return null;
  }
  if (!authContext.actorPrincipalId) {
    return httpError('FORBIDDEN', 'Actor is not the bound guardian for this channel', 403);
  }
  const binding = getActiveBinding(DAEMON_INTERNAL_ASSISTANT_ID, 'vellum');
  if (!binding) {
    // No binding yet -- in pre-bootstrap state, allow through
    return null;
  }
  if (binding.guardianExternalUserId !== authContext.actorPrincipalId) {
    return httpError('FORBIDDEN', 'Actor is not the bound guardian for this channel', 403);
  }
  return null;
}

/**
 * Submit a guardian action decision.
 * Requires AuthContext with a bound guardian actor.
 *
 * Routes all decisions through the unified canonical guardian decision
 * primitive which handles CAS resolution, resolver dispatch, and grant
 * minting.
 */
export async function handleGuardianActionDecision(req: Request, authContext: AuthContext): Promise<Response> {
  const guardianError = requireBoundGuardian(authContext);
  if (guardianError) return guardianError;

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

  const VALID_ACTIONS = new Set<string>(['approve_once', 'approve_10m', 'approve_thread', 'approve_always', 'reject']);
  if (!VALID_ACTIONS.has(action)) {
    return httpError('BAD_REQUEST', `Invalid action: ${action}. Must be one of: approve_once, approve_10m, approve_thread, approve_always, reject`, 400);
  }

  // Verify conversationId scoping before applying the canonical decision.
  // The decision is allowed when the conversationId matches the request's
  // source conversation OR a recorded delivery destination conversation.
  if (conversationId) {
    const canonicalRequest = getCanonicalGuardianRequest(requestId);
    if (canonicalRequest && canonicalRequest.conversationId && !isRequestInConversationScope(requestId, conversationId)) {
      return httpError('NOT_FOUND', 'No pending guardian action found for this requestId', 404);
    }
  }

  // Resolve actor identity from the AuthContext (set by JWT middleware).
  const actorExternalUserId = authContext.actorPrincipalId ?? undefined;
  const actorPrincipalId = authContext.actorPrincipalId ?? undefined;

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
 * Uses the conversation scope helper to union requests whose source
 * `conversationId` matches AND requests delivered to this conversation.
 * This allows guardian destination threads (including macOS Vellum threads)
 * to surface prompts for all canonical kinds.
 *
 * The returned prompts normalize `conversationId` to the queried thread ID
 * for client rendering stability.
 */
export function listGuardianDecisionPrompts(params: {
  conversationId: string;
}): GuardianDecisionPrompt[] {
  const { conversationId } = params;
  const prompts: GuardianDecisionPrompt[] = [];

  const canonicalRequests = listPendingRequestsByConversationScope(conversationId);

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
  // approve/reject only (no approve_always -- guardian-on-behalf invariant).
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
    // Normalize to the queried thread ID for client rendering stability.
    // The canonical request's source conversationId may differ from the
    // guardian destination thread the client is viewing.
    conversationId,
    callSessionId: req.callSessionId ?? null,
    kind: req.kind,
  };
}
