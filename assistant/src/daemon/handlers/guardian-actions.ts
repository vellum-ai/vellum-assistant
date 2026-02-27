import type { GuardianActionDecision, GuardianActionsPendingRequest } from '../ipc-protocol.js';
import { listGuardianDecisionPrompts } from '../../runtime/routes/guardian-action-routes.js';
import { getPendingApprovalForRequest } from '../../memory/channel-guardian-store.js';
import { applyGuardianDecision } from '../../approvals/guardian-decision-primitive.js';
import * as pendingInteractions from '../../runtime/pending-interactions.js';
import { defineHandlers, log } from './shared.js';

export const guardianActionsHandlers = defineHandlers({
  guardian_actions_pending_request: (msg: GuardianActionsPendingRequest, socket, ctx) => {
    const prompts = listGuardianDecisionPrompts({ conversationId: msg.conversationId });
    ctx.send(socket, { type: 'guardian_actions_pending_response', prompts });
  },

  guardian_action_decision: (msg: GuardianActionDecision, socket, ctx) => {
    // Try the channel guardian approval store first (tool approval prompts)
    const approval = getPendingApprovalForRequest(msg.requestId);
    if (approval) {
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
        requestId: result.requestId,
      });
      return;
    }

    // Fall back to the pending interactions tracker (direct confirmation requests)
    const interaction = pendingInteractions.get(msg.requestId);
    if (interaction) {
      const decision = msg.action === 'reject' ? 'deny' : 'allow';
      const resolved = pendingInteractions.resolve(msg.requestId);
      if (!resolved) {
        ctx.send(socket, {
          type: 'guardian_action_decision_response',
          applied: false,
          reason: 'stale',
        });
        return;
      }
      resolved.session.handleConfirmationResponse(msg.requestId, decision);
      ctx.send(socket, {
        type: 'guardian_action_decision_response',
        applied: true,
        requestId: msg.requestId,
      });
      return;
    }

    log.warn({ requestId: msg.requestId }, 'No pending guardian action found for requestId');
    ctx.send(socket, {
      type: 'guardian_action_decision_response',
      applied: false,
      reason: 'not_found',
    });
  },
});
