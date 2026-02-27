/**
 * Resolver registry for canonical guardian requests.
 *
 * Dispatches to kind-specific resolvers after the unified decision primitive
 * has validated identity, status, and performed CAS resolution.  Each
 * resolver adapts the existing side-effect logic (channel approval handling,
 * voice call answer delivery) to the canonical request domain.
 *
 * The registry is intentionally a simple Map keyed by request kind.  New
 * request kinds (access_request, etc.) can register resolvers here without
 * touching the core decision primitive.
 */

import { answerCall } from '../calls/call-domain.js';
import type { CanonicalGuardianRequest } from '../memory/canonical-guardian-store.js';
import {
  getByPendingQuestionId,
  resolveGuardianActionRequest,
} from '../memory/guardian-action-store.js';
import type { ApprovalAction } from '../runtime/channel-approval-types.js';
import * as pendingInteractions from '../runtime/pending-interactions.js';
import { addRule } from '../permissions/trust-store.js';
import { getTool } from '../tools/registry.js';
import { getLogger } from '../util/logger.js';

const log = getLogger('guardian-request-resolvers');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Actor context for the entity making the decision. */
export interface ActorContext {
  /** External user ID of the deciding actor (undefined for desktop/trusted). */
  externalUserId: string | undefined;
  /** Channel the decision arrived on. */
  channel: string;
  /** Whether the actor is a trusted/desktop context. */
  isTrusted: boolean;
}

/** The decision being applied. */
export interface ResolverDecision {
  /** The effective action after any downgrade (e.g. approve_always -> approve_once). */
  action: ApprovalAction;
  /** Optional user-supplied text (e.g. answer text for pending questions). */
  userText?: string;
}

/** Context passed to each resolver after CAS resolution succeeds. */
export interface ResolverContext {
  /** The canonical request record (already resolved to its terminal status). */
  request: CanonicalGuardianRequest;
  /** The decision being applied. */
  decision: ResolverDecision;
  /** Actor context for the entity making the decision. */
  actor: ActorContext;
}

/** Discriminated result from a resolver. */
export type ResolverResult =
  | { ok: true; applied: true; grantMinted?: boolean }
  | { ok: false; reason: string };

/** Interface that kind-specific resolvers implement. */
export interface GuardianRequestResolver {
  /** The request kind this resolver handles (matches canonical_guardian_requests.kind). */
  kind: string;
  /** Execute kind-specific side effects after CAS resolution. */
  resolve(context: ResolverContext): Promise<ResolverResult>;
}

// ---------------------------------------------------------------------------
// Resolver implementations
// ---------------------------------------------------------------------------

/**
 * Resolves `tool_approval` requests — the channel/desktop approval path.
 *
 * Adapts the existing `handleChannelDecision` logic: looks up the pending
 * interaction by conversation ID, maps the canonical decision to the
 * session's confirmation response, and resolves the interaction.
 *
 * Side effects are deferred to callers that wire into existing channel
 * approval infrastructure.  This resolver focuses on validating that the
 * request shape is appropriate for tool_approval handling.
 */
const pendingInteractionResolver: GuardianRequestResolver = {
  kind: 'tool_approval',

  async resolve(ctx: ResolverContext): Promise<ResolverResult> {
    const { request, decision } = ctx;

    if (!request.conversationId) {
      return { ok: false, reason: 'tool_approval request missing conversationId' };
    }

    // Look up the pending interaction directly by requestId.
    const interaction = pendingInteractions.get(request.id);
    if (!interaction) {
      // The pending interaction was already consumed (stale) or not found.
      // The canonical CAS already committed, so this is not an error — just
      // means the interaction was resolved by another path (e.g. timeout).
      log.warn(
        {
          event: 'resolver_tool_approval_stale',
          requestId: request.id,
          conversationId: request.conversationId,
        },
        'Tool approval resolver: pending interaction not found (already consumed or timed out)',
      );
      return { ok: false, reason: 'pending_interaction_not_found' };
    }

    // Handle approve_always: persist a trust rule when the confirmation
    // explicitly allows persistence and provides explicit options.
    if (decision.action === 'approve_always' || decision.action === 'approve_once') {
      const details = interaction.confirmationDetails;
      if (
        decision.action === 'approve_always' &&
        details &&
        details.persistentDecisionsAllowed !== false &&
        details.allowlistOptions?.length &&
        details.scopeOptions?.length
      ) {
        const pattern = details.allowlistOptions[0].pattern;
        const scope = details.scopeOptions[0].scope;
        const tool = getTool(details.toolName);
        const executionTarget = tool?.origin === 'skill' ? details.executionTarget : undefined;
        addRule(details.toolName, pattern, scope, 'allow', 100, { executionTarget });
      }
    }

    // Resolve the interaction: remove from tracker and get the session.
    const resolved = pendingInteractions.resolve(request.id);
    if (!resolved) {
      // Race condition: interaction was consumed between get() and resolve().
      log.warn(
        {
          event: 'resolver_tool_approval_resolve_race',
          requestId: request.id,
        },
        'Tool approval resolver: pending interaction consumed between lookup and resolve',
      );
      return { ok: false, reason: 'pending_interaction_race' };
    }

    // Map action to the permission system's UserDecision type and notify session.
    const userDecision = decision.action === 'reject' ? 'deny' as const : 'allow' as const;
    resolved.session.handleConfirmationResponse(request.id, userDecision);

    log.info(
      {
        event: 'resolver_tool_approval_applied',
        requestId: request.id,
        action: decision.action,
        conversationId: request.conversationId,
        toolName: request.toolName,
      },
      'Tool approval resolver: pending interaction resolved',
    );

    return { ok: true, applied: true };
  },
};

/**
 * Resolves `pending_question` requests — the voice call question path.
 *
 * Adapts the existing `answerCall` + `resolveGuardianActionRequest` logic:
 * validates that voice-specific fields (callSessionId, pendingQuestionId)
 * are present, and signals that the answer has been captured.
 *
 * Actual call session answer delivery is handled downstream by existing
 * voice infrastructure.  This resolver validates the request shape and
 * records the resolution.
 */
const pendingQuestionResolver: GuardianRequestResolver = {
  kind: 'pending_question',

  async resolve(ctx: ResolverContext): Promise<ResolverResult> {
    const { request, decision, actor } = ctx;

    if (!request.callSessionId) {
      return { ok: false, reason: 'pending_question request missing callSessionId' };
    }

    if (!request.pendingQuestionId) {
      return { ok: false, reason: 'pending_question request missing pendingQuestionId' };
    }

    // Derive the answer text from the decision. For approve actions, use the
    // guardian's text if present; otherwise use a default affirmative answer.
    // For reject, use the text or a default denial.
    const answerText = decision.userText
      ?? (decision.action === 'reject' ? 'No' : 'Yes');

    // 1. Deliver the answer to the voice call session.
    const answerResult = await answerCall({
      callSessionId: request.callSessionId,
      answer: answerText,
      pendingQuestionId: request.pendingQuestionId,
    });

    if (!('ok' in answerResult) || !answerResult.ok) {
      const errorMsg = 'error' in answerResult ? answerResult.error : 'Unknown error';
      log.warn(
        {
          event: 'resolver_pending_question_answer_failed',
          requestId: request.id,
          callSessionId: request.callSessionId,
          error: errorMsg,
        },
        'Pending question resolver: answerCall failed',
      );
      // Even though answerCall failed, continue to resolve the legacy record
      // so the system stays consistent. The call may have already timed out.
    }

    // 2. Resolve the legacy guardian action request (if it exists).
    // Look up by pendingQuestionId to find the matching legacy record.
    const legacyRequest = getByPendingQuestionId(request.pendingQuestionId);
    if (legacyRequest) {
      resolveGuardianActionRequest(
        legacyRequest.id,
        answerText,
        actor.channel,
        actor.externalUserId,
      );
    }

    log.info(
      {
        event: 'resolver_pending_question_applied',
        requestId: request.id,
        action: decision.action,
        callSessionId: request.callSessionId,
        pendingQuestionId: request.pendingQuestionId,
        answerText,
        answerCallOk: 'ok' in (answerResult as any) ? (answerResult as any).ok : false,
        legacyResolved: !!legacyRequest,
      },
      'Pending question resolver: canonical decision applied',
    );

    return { ok: true, applied: true };
  },
};

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

const resolverRegistry = new Map<string, GuardianRequestResolver>();

/** Register a resolver for a given request kind. */
export function registerResolver(resolver: GuardianRequestResolver): void {
  resolverRegistry.set(resolver.kind, resolver);
}

/** Look up the resolver for a given request kind. */
export function getResolver(kind: string): GuardianRequestResolver | undefined {
  return resolverRegistry.get(kind);
}

/** Return all registered resolver kinds (for diagnostics). */
export function getRegisteredKinds(): string[] {
  return Array.from(resolverRegistry.keys());
}

// Register built-in resolvers
registerResolver(pendingInteractionResolver);
registerResolver(pendingQuestionResolver);
