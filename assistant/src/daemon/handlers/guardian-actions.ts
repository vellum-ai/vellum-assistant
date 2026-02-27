import type { GuardianActionDecision, GuardianActionsPendingRequest } from '../ipc-protocol.js';
import { listGuardianDecisionPrompts } from '../../runtime/routes/guardian-action-routes.js';
import { getPendingApprovalForRequest } from '../../memory/channel-guardian-store.js';
import { applyGuardianDecision } from '../../approvals/guardian-decision-primitive.js';
import { handleChannelDecision } from '../../runtime/channel-approvals.js';
import type { ApprovalAction } from '../../runtime/channel-approval-types.js';
import * as pendingInteractions from '../../runtime/pending-interactions.js';
import { defineHandlers, log } from './shared.js';

const VALID_ACTIONS = new Set<string>(['approve_once', 'approve_always', 'reject']);

export const guardianActionsHandlers = defineHandlers({
  guardian_actions_pending_request: (msg: GuardianActionsPendingRequest, socket, ctx) => {
    const prompts = listGuardianDecisionPrompts({ conversationId: msg.conversationId });
    ctx.send(socket, { type: 'guardian_actions_pending_response', prompts });
  },

  guardian_action_decision: (msg: GuardianActionDecision, socket, ctx) => {
    // Validate the action is one of the known actions
    if (!VALID_ACTIONS.has(msg.action)) {
      log.warn({ requestId: msg.requestId, action: msg.action }, 'Invalid guardian action');
      ctx.send(socket, {
        type: 'guardian_action_decision_response',
        applied: false,
        reason: 'invalid_action',
      });
      return;
    }

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

    // Fall back to the pending interactions tracker (direct confirmation requests).
    // Route through handleChannelDecision so approve_always properly persists trust rules.
    const interaction = pendingInteractions.get(msg.requestId);
    if (interaction) {
      const result = handleChannelDecision(
        interaction.conversationId,
        { action: msg.action as ApprovalAction, source: 'plain_text', requestId: msg.requestId },
      );
      ctx.send(socket, {
        type: 'guardian_action_decision_response',
        applied: result.applied,
        requestId: result.requestId,
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
