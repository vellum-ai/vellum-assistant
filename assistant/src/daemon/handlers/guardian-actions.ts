import {
  applyCanonicalGuardianDecision,
  applyGuardianDecision,
} from '../../approvals/guardian-decision-primitive.js';
import { getPendingApprovalForRequest } from '../../memory/channel-guardian-store.js';
import type { ApprovalAction } from '../../runtime/channel-approval-types.js';
import { handleChannelDecision } from '../../runtime/channel-approvals.js';
import * as pendingInteractions from '../../runtime/pending-interactions.js';
import { handleAccessRequestDecision } from '../../runtime/routes/access-request-decision.js';
import { listGuardianDecisionPrompts } from '../../runtime/routes/guardian-action-routes.js';
import type { GuardianActionDecision, GuardianActionsPendingRequest } from '../ipc-protocol.js';
import { defineHandlers, log } from './shared.js';

const VALID_ACTIONS = new Set<string>(['approve_once', 'approve_always', 'reject']);

export const guardianActionsHandlers = defineHandlers({
  guardian_actions_pending_request: (msg: GuardianActionsPendingRequest, socket, ctx) => {
    const prompts = listGuardianDecisionPrompts({ conversationId: msg.conversationId });
    ctx.send(socket, { type: 'guardian_actions_pending_response', conversationId: msg.conversationId, prompts });
  },

  guardian_action_decision: async (msg: GuardianActionDecision, socket, ctx) => {
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

    // ── Canonical-first: try the unified canonical guardian decision primitive ──
    const canonicalResult = await applyCanonicalGuardianDecision({
      requestId: msg.requestId,
      action: msg.action as ApprovalAction,
      actorContext: {
        externalUserId: undefined,
        channel: 'vellum',
        isTrusted: true,
      },
      userText: undefined,
    });

    if (canonicalResult.applied) {
      ctx.send(socket, {
        type: 'guardian_action_decision_response',
        applied: true,
        requestId: canonicalResult.requestId,
      });
      return;
    }

    // If the canonical request was found but couldn't be applied (stale, expired, etc.),
    // return the reason rather than falling through to legacy.
    if (canonicalResult.applied === false && canonicalResult.reason !== 'not_found') {
      ctx.send(socket, {
        type: 'guardian_action_decision_response',
        applied: false,
        reason: canonicalResult.reason,
        requestId: msg.requestId,
      });
      return;
    }

    // ── Legacy fallback: canonical request not found, try legacy stores ──

    // Try the channel guardian approval store (tool approval prompts)
    const approval = getPendingApprovalForRequest(msg.requestId);
    if (approval) {
      // Enforce conversationId scoping when provided.
      if (msg.conversationId && msg.conversationId !== approval.conversationId) {
        log.warn({ requestId: msg.requestId, expected: approval.conversationId, got: msg.conversationId }, 'conversationId mismatch');
        ctx.send(socket, {
          type: 'guardian_action_decision_response',
          applied: false,
          reason: 'conversation_mismatch',
          requestId: msg.requestId,
        });
        return;
      }

      // Access request approvals need a separate decision path — they don't have
      // pending interactions and use verification sessions instead.
      if (approval.toolName === 'ingress_access_request') {
        const mappedAction = msg.action === 'reject' ? 'deny' as const : 'approve' as const;
        // Use 'desktop' as the actor identity because this endpoint is
        // unauthenticated — we cannot verify the caller is the assigned
        // guardian, so we record a generic desktop origin instead of
        // falsely attributing the decision to guardianExternalUserId.
        const decisionResult = handleAccessRequestDecision(
          approval,
          mappedAction,
          'desktop',
        );
        ctx.send(socket, {
          type: 'guardian_action_decision_response',
          applied: decisionResult.type !== 'stale',
          requestId: msg.requestId,
          reason: decisionResult.type === 'stale' ? 'stale' : undefined,
        });
        return;
      }

      const result = applyGuardianDecision({
        approval,
        decision: { action: msg.action as 'approve_once' | 'approve_always' | 'reject', source: 'plain_text', requestId: msg.requestId },
        actorExternalUserId: undefined,
        actorChannel: 'vellum',
      });
      ctx.send(socket, {
        type: 'guardian_action_decision_response',
        applied: result.applied,
        reason: result.reason,
        requestId: result.requestId ?? msg.requestId,
      });
      return;
    }

    // Fall back to the pending interactions tracker (direct confirmation requests).
    // Route through handleChannelDecision so approve_always properly persists trust rules.
    const interaction = pendingInteractions.get(msg.requestId);
    if (interaction) {
      // Enforce conversationId scoping when provided.
      if (msg.conversationId && msg.conversationId !== interaction.conversationId) {
        log.warn({ requestId: msg.requestId, expected: interaction.conversationId, got: msg.conversationId }, 'conversationId mismatch');
        ctx.send(socket, {
          type: 'guardian_action_decision_response',
          applied: false,
          reason: 'conversation_mismatch',
          requestId: msg.requestId,
        });
        return;
      }

      const result = handleChannelDecision(
        interaction.conversationId,
        { action: msg.action as ApprovalAction, source: 'plain_text', requestId: msg.requestId },
      );
      ctx.send(socket, {
        type: 'guardian_action_decision_response',
        applied: result.applied,
        requestId: result.requestId ?? msg.requestId,
      });
      return;
    }

    log.warn({ requestId: msg.requestId }, 'No pending guardian action found for requestId');
    ctx.send(socket, {
      type: 'guardian_action_decision_response',
      applied: false,
      reason: 'not_found',
      requestId: msg.requestId,
    });
  },
});
