import {
  applyCanonicalGuardianDecision,
} from '../../approvals/guardian-decision-primitive.js';
import { getCanonicalGuardianRequest } from '../../memory/canonical-guardian-store.js';
import type { ApprovalAction } from '../../runtime/channel-approval-types.js';
import { resolveLocalIpcGuardianContext } from '../../runtime/local-actor-identity.js';
import { listGuardianDecisionPrompts } from '../../runtime/routes/guardian-action-routes.js';
import type { GuardianActionDecision, GuardianActionsPendingRequest } from '../ipc-protocol.js';
import { defineHandlers, log } from './shared.js';

const VALID_ACTIONS = new Set<string>(['approve_once', 'approve_10m', 'approve_thread', 'approve_always', 'reject']);

export const guardianActionsHandlers = defineHandlers({
  guardian_actions_pending_request: (msg: GuardianActionsPendingRequest, socket, ctx) => {
    const prompts = listGuardianDecisionPrompts({ conversationId: msg.conversationId });
    ctx.send(socket, { type: 'guardian_actions_pending_response', conversationId: msg.conversationId, prompts });
  },

  guardian_action_decision: async (msg: GuardianActionDecision, socket, ctx) => {
    try {
    // Validate the action is one of the known actions
    if (!VALID_ACTIONS.has(msg.action)) {
      log.warn({ requestId: msg.requestId, action: msg.action }, 'Invalid guardian action');
      ctx.send(socket, {
        type: 'guardian_action_decision_response',
        applied: false,
        reason: 'invalid_action',
        requestId: msg.requestId,
      });
      return;
    }

    // Verify conversationId scoping before applying the canonical decision.
    // A caller must not be able to cross-resolve requests from a different conversation.
    if (msg.conversationId) {
      const canonicalRequest = getCanonicalGuardianRequest(msg.requestId);
      if (canonicalRequest && canonicalRequest.conversationId && canonicalRequest.conversationId !== msg.conversationId) {
        log.warn({ requestId: msg.requestId, expected: canonicalRequest.conversationId, got: msg.conversationId }, 'conversationId mismatch');
        ctx.send(socket, {
          type: 'guardian_action_decision_response',
          applied: false,
          reason: 'not_found',
          requestId: msg.requestId,
        });
        return;
      }
    }

    // Resolve the local IPC actor's principal via the vellum guardian binding.
    const localGuardianCtx = resolveLocalIpcGuardianContext('vellum');
    const canonicalResult = await applyCanonicalGuardianDecision({
      requestId: msg.requestId,
      action: msg.action as ApprovalAction,
      actorContext: {
        externalUserId: localGuardianCtx.guardianExternalUserId,
        channel: 'vellum',
        guardianPrincipalId: localGuardianCtx.guardianPrincipalId ?? undefined,
      },
      userText: undefined,
    });

    if (canonicalResult.applied) {
      // When the CAS committed but the resolver failed, the side effect
      // (e.g. minting a verification session) did not happen. From the
      // caller's perspective the decision was not truly applied.
      if (canonicalResult.resolverFailed) {
        ctx.send(socket, {
          type: 'guardian_action_decision_response',
          applied: false,
          reason: 'resolver_failed',
          resolverFailureReason: canonicalResult.resolverFailureReason,
          requestId: canonicalResult.requestId,
        });
        return;
      }

      ctx.send(socket, {
        type: 'guardian_action_decision_response',
        applied: true,
        requestId: canonicalResult.requestId,
      });
      return;
    }

    // Return the reason for failure (stale, expired, not_found, etc.)
    ctx.send(socket, {
      type: 'guardian_action_decision_response',
      applied: false,
      reason: canonicalResult.reason,
      requestId: msg.requestId,
    });
    } catch (err) {
      log.error({ err, requestId: msg.requestId }, 'guardian_action_decision: unhandled error');
      ctx.send(socket, {
        type: 'guardian_action_decision_response',
        applied: false,
        reason: 'internal_error',
        requestId: msg.requestId,
      });
    }
  },
});
