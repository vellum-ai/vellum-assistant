/**
 * Approval interception: checks for pending approvals and handles inbound
 * messages as decisions, reminders, or conversational follow-ups.
 */
import { applyGuardianDecision } from '../../approvals/guardian-decision-primitive.js';
import type { ChannelId } from '../../channels/types.js';
import {
  getAllPendingApprovalsByGuardianChat,
  getPendingApprovalByRequestAndGuardianChat,
  getPendingApprovalForRequest,
  getUnresolvedApprovalForRequest,
  type GuardianApprovalRequest,
  updateApprovalDecision,
} from '../../memory/channel-guardian-store.js';
import { emitNotificationSignal } from '../../notifications/emit-signal.js';
import { getLogger } from '../../util/logger.js';
import { runApprovalConversationTurn } from '../approval-conversation-turn.js';
import { composeApprovalMessageGenerative } from '../approval-message-composer.js';
import { parseApprovalDecision } from '../channel-approval-parser.js';
import type {
  ApprovalDecisionResult,
} from '../channel-approval-types.js';
import {
  getApprovalInfoByConversation,
  getChannelApprovalPrompt,
  handleChannelDecision,
} from '../channel-approvals.js';
import { deliverChannelReply } from '../gateway-client.js';
import type {
  ApprovalConversationContext,
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
} from '../http-types.js';
import {
  deliverVerificationCodeToGuardian,
  type DeliveryResult,
  handleAccessRequestDecision,
  notifyRequesterOfApproval,
  notifyRequesterOfDeliveryFailure,
  notifyRequesterOfDenial,
} from './access-request-decision.js';
import {
  buildGuardianDenyContext,
  type GuardianContext,
  parseCallbackData,
} from './channel-route-shared.js';

const log = getLogger('runtime-http');

export interface ApprovalInterceptionParams {
  conversationId: string;
  callbackData?: string;
  content: string;
  externalChatId: string;
  sourceChannel: ChannelId;
  senderExternalUserId?: string;
  replyCallbackUrl: string;
  bearerToken?: string;
  guardianCtx: GuardianContext;
  assistantId: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  approvalConversationGenerator?: ApprovalConversationGenerator;
}

export interface ApprovalInterceptionResult {
  handled: boolean;
  type?: 'decision_applied' | 'assistant_turn' | 'guardian_decision_applied' | 'stale_ignored';
}

/**
 * Check for pending approvals and handle inbound messages accordingly.
 *
 * Returns `{ handled: true }` when the message was consumed by the approval
 * flow (either as a decision or a reminder), so the caller should NOT proceed
 * to normal message processing.
 *
 * When the sender is a guardian responding from their chat, also checks for
 * pending guardian approval requests and routes the decision accordingly.
 */
export async function handleApprovalInterception(
  params: ApprovalInterceptionParams,
): Promise<ApprovalInterceptionResult> {
  const {
    conversationId,
    callbackData,
    content,
    externalChatId,
    sourceChannel,
    senderExternalUserId,
    replyCallbackUrl,
    bearerToken,
    guardianCtx,
    assistantId,
    approvalCopyGenerator,
    approvalConversationGenerator,
  } = params;

  // ── Guardian approval decision path ──
  // When the sender is the guardian and there's a pending guardian approval
  // request targeting this chat, the message might be a decision on behalf
  // of a non-guardian requester.
  if (
    guardianCtx.trustClass === 'guardian' &&
    senderExternalUserId
  ) {
    // Callback/button path: deterministic and takes priority.
    let callbackDecision: ApprovalDecisionResult | null = null;
    if (callbackData) {
      callbackDecision = parseCallbackData(callbackData, sourceChannel);
    }

    // When a callback button provides a request ID, use the scoped lookup so
    // the decision resolves to exactly the right approval even when
    // multiple approvals target the same guardian chat.
    let guardianApproval = callbackDecision?.requestId
      ? getPendingApprovalByRequestAndGuardianChat(callbackDecision.requestId, sourceChannel, externalChatId, assistantId)
      : null;

    // When the scoped lookup didn't resolve an approval (either because
    // there was no callback or the requestId pointed to a stale/expired request),
    // fall back to checking all pending approvals for this guardian chat.
    if (!guardianApproval && callbackDecision) {
      const allPending = getAllPendingApprovalsByGuardianChat(sourceChannel, externalChatId, assistantId);
      if (allPending.length === 1) {
        guardianApproval = allPending[0];
      } else if (allPending.length > 1) {
        // The callback targeted a stale/expired request but the guardian has other
        // pending approvals. Inform them the clicked approval is no longer valid.
        try {
          const staleText = await composeApprovalMessageGenerative({
            scenario: 'guardian_disambiguation',
            pendingCount: allPending.length,
            channel: sourceChannel,
          }, {}, approvalCopyGenerator);
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: staleText,
            assistantId,
          }, bearerToken);
        } catch (err) {
          log.error({ err, externalChatId }, 'Failed to deliver stale callback disambiguation notice');
        }
        return { handled: true, type: 'stale_ignored' };
      }
    }

    // For plain-text messages (no callback), check if there are any pending
    // approvals for this guardian chat to route through the conversation engine.
    if (!guardianApproval && !callbackDecision) {
      const allPending = getAllPendingApprovalsByGuardianChat(sourceChannel, externalChatId, assistantId);
      if (allPending.length === 1) {
        guardianApproval = allPending[0];
      } else if (allPending.length > 1) {
        // Multiple pending — pick the first approval matching this sender as
        // primary context. The conversation engine sees all matching approvals
        // via pendingApprovals and can disambiguate.
        guardianApproval = allPending.find(a => a.guardianExternalUserId === senderExternalUserId) ?? allPending[0];
      }
    }

    if (guardianApproval) {
      // Validate that the sender is the specific guardian who was assigned
      // this approval request. This is a defense-in-depth check — the
      // trustClass check above already verifies the sender is a guardian,
      // but this catches edge cases like binding rotation between request
      // creation and decision.
      if (senderExternalUserId !== guardianApproval.guardianExternalUserId) {
        log.warn(
          { externalChatId, senderExternalUserId, expectedGuardian: guardianApproval.guardianExternalUserId },
          'Non-guardian sender attempted to act on guardian approval request',
        );
        try {
          const mismatchText = await composeApprovalMessageGenerative({
            scenario: 'guardian_identity_mismatch',
            channel: sourceChannel,
          }, {}, approvalCopyGenerator);
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: mismatchText,
            assistantId,
          }, bearerToken);
        } catch (err) {
          log.error({ err, externalChatId }, 'Failed to deliver guardian identity rejection notice');
        }
        return { handled: true, type: 'guardian_decision_applied' };
      }

      if (callbackDecision) {
        // Access request approvals don't have a pending interaction in the
        // session tracker, so they need a separate decision path that creates
        // a verification session instead of resuming an agent loop.
        if (guardianApproval.toolName === 'ingress_access_request') {
          const accessResult = await handleAccessRequestApproval(
            guardianApproval,
            callbackDecision.action === 'reject' ? 'deny' : 'approve',
            senderExternalUserId,
            replyCallbackUrl,
            assistantId,
            bearerToken,
          );
          return accessResult;
        }

        // Apply the decision through the unified guardian decision primitive.
        // The primitive handles approve_always downgrade, approval info capture,
        // record update, and scoped grant minting.
        const result = applyGuardianDecision({
          approval: guardianApproval,
          decision: callbackDecision,
          actorExternalUserId: senderExternalUserId,
          actorChannel: sourceChannel,
        });

        if (result.applied) {
          // Notify the requester's chat about the outcome with the tool name
          const effectiveAction = callbackDecision.action === 'approve_always' ? 'approve_once' : callbackDecision.action;
          const outcomeText = await composeApprovalMessageGenerative({
            scenario: 'guardian_decision_outcome',
            decision: effectiveAction === 'reject' ? 'denied' : 'approved',
            toolName: guardianApproval.toolName,
            channel: sourceChannel,
          }, {}, approvalCopyGenerator);
          try {
            await deliverChannelReply(replyCallbackUrl, {
              chatId: guardianApproval.requesterChatId,
              text: outcomeText,
              assistantId,
            }, bearerToken);
          } catch (err) {
            log.error({ err, conversationId: guardianApproval.conversationId }, 'Failed to notify requester of guardian decision');
          }

          // Post-decision delivery is handled by the onEvent callback
          // in the session that registered the pending interaction.
          return { handled: true, type: 'guardian_decision_applied' };
        }

        // Race condition: callback arrived after request was already resolved.
        return { handled: true, type: 'stale_ignored' };
      }

      // ── Conversational engine for guardian plain-text messages ──
      // Gather all pending guardian approvals for this chat so the engine
      // can handle disambiguation when multiple are pending.
      const allGuardianPending = getAllPendingApprovalsByGuardianChat(sourceChannel, externalChatId, assistantId);
      // Only present approvals that belong to this sender so the engine
      // does not offer disambiguation for requests assigned to a rotated
      // guardian the sender cannot act on.
      const senderPending = allGuardianPending.filter(a => a.guardianExternalUserId === senderExternalUserId);
      const effectivePending = senderPending.length > 0 ? senderPending : allGuardianPending;
      if (effectivePending.length > 0 && approvalConversationGenerator && content) {
        const guardianAllowedActions = ['approve_once', 'reject'];
        const engineContext: ApprovalConversationContext = {
          toolName: guardianApproval.toolName,
          allowedActions: guardianAllowedActions,
          role: 'guardian',
          pendingApprovals: effectivePending.map((a) => ({ requestId: a.requestId ?? a.runId, toolName: a.toolName })),
          userMessage: content,
        };

        const engineResult = await runApprovalConversationTurn(engineContext, approvalConversationGenerator);

        if (engineResult.disposition === 'keep_pending') {
          // Non-decision follow-up (clarification, disambiguation, etc.)
          try {
            await deliverChannelReply(replyCallbackUrl, {
              chatId: externalChatId,
              text: engineResult.replyText,
              assistantId,
            }, bearerToken);
          } catch (err) {
            log.error({ err, conversationId: guardianApproval.conversationId }, 'Failed to deliver guardian conversation reply');
          }
          return { handled: true, type: 'assistant_turn' };
        }

        // Decision-bearing disposition from the engine
        let decisionAction = engineResult.disposition as 'approve_once' | 'approve_always' | 'reject';

        // Belt-and-suspenders: guardians cannot approve_always even if the
        // engine returns it (the engine's allowedActions validation should
        // already prevent this, but enforce it here too).
        if (decisionAction === 'approve_always') {
          decisionAction = 'approve_once';
        }

        // Resolve the target approval: use targetRequestId from the engine if
        // provided, otherwise use the single guardian approval.
        const targetApproval = engineResult.targetRequestId
          ? allGuardianPending.find((a) => (a.requestId ?? a.runId) === engineResult.targetRequestId) ?? guardianApproval
          : guardianApproval;

        // Re-validate guardian identity against the resolved target. The
        // engine may select a different pending approval (via targetRequestId)
        // that was assigned to a different guardian. Without this check a
        // currently bound guardian could act on a request assigned to a
        // previous guardian after a binding rotation.
        if (senderExternalUserId !== targetApproval.guardianExternalUserId) {
          log.warn(
            { externalChatId, senderExternalUserId, expectedGuardian: targetApproval.guardianExternalUserId, targetRequestId: engineResult.targetRequestId },
            'Guardian identity mismatch on engine-selected target approval',
          );
          try {
            const mismatchText = await composeApprovalMessageGenerative({
              scenario: 'guardian_identity_mismatch',
              channel: sourceChannel,
            }, {}, approvalCopyGenerator);
            await deliverChannelReply(replyCallbackUrl, {
              chatId: externalChatId,
              text: mismatchText,
              assistantId,
            }, bearerToken);
          } catch (err) {
            log.error({ err, externalChatId }, 'Failed to deliver guardian identity mismatch notice for engine target');
          }
          return { handled: true, type: 'guardian_decision_applied' };
        }

        // Access request approvals need a separate decision path.
        if (targetApproval.toolName === 'ingress_access_request') {
          const accessResult = await handleAccessRequestApproval(
            targetApproval,
            decisionAction === 'reject' ? 'deny' : 'approve',
            senderExternalUserId,
            replyCallbackUrl,
            assistantId,
            bearerToken,
          );
          return accessResult;
        }

        const engineDecision: ApprovalDecisionResult = {
          action: decisionAction,
          source: 'plain_text',
          ...(engineResult.targetRequestId ? { requestId: engineResult.targetRequestId } : {}),
        };

        // Apply the decision through the unified guardian decision primitive.
        const result = applyGuardianDecision({
          approval: targetApproval,
          decision: engineDecision,
          actorExternalUserId: senderExternalUserId,
          actorChannel: sourceChannel,
        });

        if (result.applied) {
          // Notify the requester's chat about the outcome
          const outcomeText = await composeApprovalMessageGenerative({
            scenario: 'guardian_decision_outcome',
            decision: decisionAction === 'reject' ? 'denied' : 'approved',
            toolName: targetApproval.toolName,
            channel: sourceChannel,
          }, {}, approvalCopyGenerator);
          try {
            await deliverChannelReply(replyCallbackUrl, {
              chatId: targetApproval.requesterChatId,
              text: outcomeText,
              assistantId,
            }, bearerToken);
          } catch (err) {
            log.error({ err, conversationId: targetApproval.conversationId }, 'Failed to notify requester of guardian decision');
          }

          // Deliver the engine's reply to the guardian
          try {
            await deliverChannelReply(replyCallbackUrl, {
              chatId: externalChatId,
              text: engineResult.replyText,
              assistantId,
            }, bearerToken);
          } catch (err) {
            log.error({ err, conversationId: targetApproval.conversationId }, 'Failed to deliver guardian decision reply');
          }

          return { handled: true, type: 'guardian_decision_applied' };
        }

        // Race condition: request was already resolved. Deliver a stale notice
        // instead of the engine's optimistic reply.
        try {
          const staleText = await composeApprovalMessageGenerative({
            scenario: 'approval_already_resolved',
            channel: sourceChannel,
          }, {}, approvalCopyGenerator);
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: staleText,
            assistantId,
          }, bearerToken);
        } catch (err) {
          log.error({ err, conversationId: targetApproval.conversationId }, 'Failed to deliver stale guardian approval notice');
        }

        return { handled: true, type: 'stale_ignored' };
      }

      // ── Legacy fallback when no conversational engine is available ──
      // Use the deterministic parser to handle guardian plain-text so that
      // simple yes/no replies still work when the engine is not injected.
      if (content && !approvalConversationGenerator) {
        const legacyGuardianDecision = parseApprovalDecision(content);
        if (legacyGuardianDecision) {
          // Guardians cannot approve_always — downgrade to approve_once.
          if (legacyGuardianDecision.action === 'approve_always') {
            legacyGuardianDecision.action = 'approve_once';
          }

          // Resolve the target approval: when a [ref:<requestId>] tag is
          // present, look up the specific pending approval by that requestId
          // so the decision applies to the correct conversation even when
          // multiple guardian approvals are pending.
          let targetLegacyApproval = guardianApproval;
          if (legacyGuardianDecision.requestId) {
            const resolvedByRequest = getPendingApprovalByRequestAndGuardianChat(
              legacyGuardianDecision.requestId,
              sourceChannel,
              externalChatId,
              assistantId,
            );
            if (!resolvedByRequest) {
              // The referenced request doesn't match any pending guardian
              // approval — it may have expired or already been resolved.
              try {
                const staleText = await composeApprovalMessageGenerative({
                  scenario: 'guardian_disambiguation',
                  channel: sourceChannel,
                }, {}, approvalCopyGenerator);
                await deliverChannelReply(replyCallbackUrl, {
                  chatId: externalChatId,
                  text: staleText,
                  assistantId,
                }, bearerToken);
              } catch (err) {
                log.error({ err, externalChatId }, 'Failed to deliver stale approval notice (legacy path)');
              }
              return { handled: true, type: 'stale_ignored' };
            }
            targetLegacyApproval = resolvedByRequest;
          }

          // Re-validate guardian identity against the resolved target.
          // The default guardianApproval was already checked, but a
          // requestId-resolved approval may belong to a different guardian.
          if (senderExternalUserId !== targetLegacyApproval.guardianExternalUserId) {
            log.warn(
              { externalChatId, senderExternalUserId, expectedGuardian: targetLegacyApproval.guardianExternalUserId, requestId: legacyGuardianDecision.requestId },
              'Guardian identity mismatch on legacy ref-resolved target approval',
            );
            try {
              const mismatchText = await composeApprovalMessageGenerative({
                scenario: 'guardian_identity_mismatch',
                channel: sourceChannel,
              }, {}, approvalCopyGenerator);
              await deliverChannelReply(replyCallbackUrl, {
                chatId: externalChatId,
                text: mismatchText,
                assistantId,
              }, bearerToken);
            } catch (err) {
              log.error({ err, externalChatId }, 'Failed to deliver guardian identity mismatch notice (legacy path)');
            }
            return { handled: true, type: 'guardian_decision_applied' };
          }

          // Access request approvals need a separate decision path.
          if (targetLegacyApproval.toolName === 'ingress_access_request') {
            const accessResult = await handleAccessRequestApproval(
              targetLegacyApproval,
              legacyGuardianDecision.action === 'reject' ? 'deny' : 'approve',
              senderExternalUserId,
              replyCallbackUrl,
              assistantId,
              bearerToken,
            );
            return accessResult;
          }

          // Apply the decision through the unified guardian decision primitive.
          const result = applyGuardianDecision({
            approval: targetLegacyApproval,
            decision: legacyGuardianDecision,
            actorExternalUserId: senderExternalUserId,
            actorChannel: sourceChannel,
          });

          if (result.applied) {
            // Notify the requester's chat about the outcome
            const outcomeText = await composeApprovalMessageGenerative({
              scenario: 'guardian_decision_outcome',
              decision: legacyGuardianDecision.action === 'reject' ? 'denied' : 'approved',
              toolName: targetLegacyApproval.toolName,
              channel: sourceChannel,
            }, {}, approvalCopyGenerator);
            try {
              await deliverChannelReply(replyCallbackUrl, {
                chatId: targetLegacyApproval.requesterChatId,
                text: outcomeText,
                assistantId,
              }, bearerToken);
            } catch (err) {
              log.error({ err, conversationId: targetLegacyApproval.conversationId }, 'Failed to notify requester of guardian decision (legacy path)');
            }

            return { handled: true, type: 'guardian_decision_applied' };
          }

          // Race condition: request was already resolved. Deliver stale notice.
          try {
            const staleText = await composeApprovalMessageGenerative({
              scenario: 'approval_already_resolved',
              channel: sourceChannel,
            }, {}, approvalCopyGenerator);
            await deliverChannelReply(replyCallbackUrl, {
              chatId: externalChatId,
              text: staleText,
              assistantId,
            }, bearerToken);
          } catch (err) {
            log.error({ err, conversationId: targetLegacyApproval.conversationId }, 'Failed to deliver stale guardian legacy fallback notice');
          }
          return { handled: true, type: 'stale_ignored' };
        }

        // No decision could be parsed — send a generic reminder to the guardian
        try {
          const reminderText = await composeApprovalMessageGenerative({
            scenario: 'reminder_prompt',
            toolName: guardianApproval.toolName,
            channel: sourceChannel,
          }, {}, approvalCopyGenerator);
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: reminderText,
            assistantId,
          }, bearerToken);
        } catch (err) {
          log.error({ err, conversationId: guardianApproval.conversationId }, 'Failed to deliver guardian reminder (legacy path)');
        }
        return { handled: true, type: 'assistant_turn' };
      }

      // No content and no engine — nothing to do, fall through to standard
      // approval interception below.
    }
  }

  // ── Standard approval interception (existing flow) ──
  const pendingPrompt = getChannelApprovalPrompt(conversationId);
  if (!pendingPrompt) return { handled: false };

  // Legacy unverified-channel equivalent:
  // unknown trust + explicit denial reason (`no_identity` / `no_binding`).
  // Unknown without a denial reason means identity-known, non-member sender
  // in a shared channel; that case must not force-reject someone else's request.
  const isLegacyUnverifiedSender = guardianCtx.trustClass === 'unknown' && !!guardianCtx.denialReason;

  // When the sender is from a legacy-unverified channel actor, auto-deny any
  // pending confirmation and block self-approval.
  if (isLegacyUnverifiedSender) {
    const pending = getApprovalInfoByConversation(conversationId);
    if (pending.length > 0) {
      handleChannelDecision(
        conversationId,
        { action: 'reject', source: 'plain_text' },
        buildGuardianDenyContext(
          pending[0].toolName,
          guardianCtx.denialReason ?? 'no_binding',
          sourceChannel,
        ),
      );
      return { handled: true, type: 'decision_applied' };
    }
  }

  // When the sender is a non-guardian and there's a pending guardian approval
  // for this conversation's request, block self-approval. The non-guardian must
  // wait for the guardian to decide.
  //
  // Include identity-known, non-member senders (`unknown` without denialReason)
  // so shared-channel participants can't approve/deny someone else's pending request.
  const isIdentityKnownNonGuardian = guardianCtx.trustClass === 'trusted_contact'
    || (guardianCtx.trustClass === 'unknown' && !guardianCtx.denialReason);
  if (isIdentityKnownNonGuardian) {
    const pending = getApprovalInfoByConversation(conversationId);
    if (pending.length > 0) {
      const guardianApprovalForRequest = getPendingApprovalForRequest(pending[0].requestId);
      if (guardianApprovalForRequest) {
        // Allow the requester to cancel their own pending guardian request.
        // Only reject/cancel is permitted — self-approval is still blocked.
        if (content) {
          let requesterCancelIntent = false;
          let cancelReplyText: string | undefined;
          let requesterFollowupReplyText: string | undefined;

          // Interpret requester follow-ups through the conversation engine so
          // "nevermind/cancel" resolves naturally while clarifying questions
          // remain conversational turns.
          if (approvalConversationGenerator) {
            const cancelContext: ApprovalConversationContext = {
              toolName: pending[0].toolName,
              allowedActions: ['reject'],
              role: 'requester',
              pendingApprovals: pending.map(p => ({ requestId: p.requestId, toolName: p.toolName })),
              userMessage: content,
            };
            const cancelResult = await runApprovalConversationTurn(cancelContext, approvalConversationGenerator);
            if (cancelResult.disposition === 'reject') {
              requesterCancelIntent = true;
              cancelReplyText = cancelResult.replyText;
            } else if (cancelResult.disposition === 'keep_pending') {
              requesterFollowupReplyText = cancelResult.replyText;
            }
          }

          if (requesterCancelIntent) {
            const rejectDecision: ApprovalDecisionResult = {
              action: 'reject',
              source: 'plain_text',
            };
            // Apply the cancel decision through the unified primitive.
            // The primitive handles record update and (no-op) grant logic.
            const cancelApplyResult = applyGuardianDecision({
              approval: guardianApprovalForRequest,
              decision: rejectDecision,
              actorExternalUserId: senderExternalUserId,
              actorChannel: sourceChannel,
            });
            if (cancelApplyResult.applied) {
              // Notify requester
              const replyText = cancelReplyText ?? await composeApprovalMessageGenerative({
                scenario: 'requester_cancel',
                toolName: pending[0].toolName,
                channel: sourceChannel,
              }, {}, approvalCopyGenerator);
              try {
                await deliverChannelReply(replyCallbackUrl, {
                  chatId: externalChatId,
                  text: replyText,
                  assistantId,
                }, bearerToken);
              } catch (err) {
                log.error({ err, conversationId }, 'Failed to deliver requester cancel notice');
              }

              // Notify guardian that the request was cancelled
              try {
                const guardianNotice = await composeApprovalMessageGenerative({
                  scenario: 'guardian_decision_outcome',
                  decision: 'denied',
                  toolName: pending[0].toolName,
                  channel: sourceChannel,
                }, {}, approvalCopyGenerator);
                await deliverChannelReply(replyCallbackUrl, {
                  chatId: guardianApprovalForRequest.guardianChatId,
                  text: guardianNotice,
                  assistantId,
                }, bearerToken);
              } catch (err) {
                log.error({ err, conversationId }, 'Failed to notify guardian of requester cancellation');
              }

              return { handled: true, type: 'decision_applied' };
            }

            // Race condition: approval was already resolved elsewhere.
            try {
              const staleText = await composeApprovalMessageGenerative({
                scenario: 'approval_already_resolved',
                channel: sourceChannel,
              }, {}, approvalCopyGenerator);
              await deliverChannelReply(replyCallbackUrl, {
                chatId: externalChatId,
                text: staleText,
                assistantId,
              }, bearerToken);
            } catch (err) {
              log.error({ err, conversationId }, 'Failed to deliver stale requester-cancel notice');
            }
            return { handled: true, type: 'stale_ignored' };
          }

          if (requesterFollowupReplyText) {
            try {
              await deliverChannelReply(replyCallbackUrl, {
                chatId: externalChatId,
                text: requesterFollowupReplyText,
                assistantId,
              }, bearerToken);
            } catch (err) {
              log.error({ err, conversationId }, 'Failed to deliver requester follow-up reply while awaiting guardian');
            }
            return { handled: true, type: 'assistant_turn' };
          }
        }

        // Not a cancel intent — tell the requester their request is pending
        try {
          const pendingText = await composeApprovalMessageGenerative({
            scenario: 'request_pending_guardian',
            channel: sourceChannel,
          }, {}, approvalCopyGenerator);
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: pendingText,
            assistantId,
          }, bearerToken);
        } catch (err) {
          log.error({ err, conversationId }, 'Failed to deliver guardian-pending notice to requester');
        }
        return { handled: true, type: 'assistant_turn' };
      }

      // Check for an expired-but-unresolved guardian approval. If the approval
      // expired without a guardian decision, auto-deny and transition
      // the approval to 'expired'. Without this, the requester could bypass
      // guardian-only controls by simply waiting for the TTL to elapse.
      const unresolvedApproval = getUnresolvedApprovalForRequest(pending[0].requestId);
      if (unresolvedApproval) {
        updateApprovalDecision(unresolvedApproval.id, { status: 'expired' });

        // Auto-deny the underlying request so it does not remain actionable
        const expiredDecision: ApprovalDecisionResult = {
          action: 'reject',
          source: 'plain_text',
        };
        handleChannelDecision(conversationId, expiredDecision);

        try {
          const expiredText = await composeApprovalMessageGenerative({
            scenario: 'guardian_expired_requester',
            toolName: pending[0].toolName,
            channel: sourceChannel,
          }, {}, approvalCopyGenerator);
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: expiredText,
            assistantId,
          }, bearerToken);
        } catch (err) {
          log.error({ err, conversationId }, 'Failed to deliver guardian-expiry notice to requester');
        }
        return { handled: true, type: 'decision_applied' };
      }

      // Guard: trusted contacts with a guardian binding must not self-approve
      // even when no guardian approval row exists yet. The guardian approval
      // row is created asynchronously when the approval prompt is delivered
      // to the guardian. In the window between the pending confirmation being
      // created (isInteractive=true) and the guardian approval row being
      // persisted, the trusted contact could otherwise fall through to the
      // standard conversational engine / legacy parser and resolve their own
      // pending request via handleChannelDecision.
      if (guardianCtx.trustClass === 'trusted_contact' && guardianCtx.guardianExternalUserId) {
        log.info(
          { conversationId, externalChatId, guardianExternalUserId: guardianCtx.guardianExternalUserId },
          'Blocking trusted-contact self-approval: pending confirmation exists but guardian approval row not yet created',
        );
        try {
          const pendingText = await composeApprovalMessageGenerative({
            scenario: 'request_pending_guardian',
            channel: sourceChannel,
          }, {}, approvalCopyGenerator);
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: pendingText,
            assistantId,
          }, bearerToken);
        } catch (err) {
          log.error({ err, conversationId }, 'Failed to deliver guardian-pending notice to trusted contact (pre-row guard)');
        }
        return { handled: true, type: 'assistant_turn' };
      }
    }
  }

  // Try to extract a decision from callback data (button press) first.
  // Callback/button path remains deterministic and takes priority.
  if (callbackData) {
    const cbDecision = parseCallbackData(callbackData, sourceChannel);
    if (cbDecision) {
      // When the decision came from a callback button, validate that the embedded
      // request ID matches a currently pending interaction. A stale button (from a
      // previous approval prompt) must not apply to a different pending interaction.
      if (cbDecision.requestId) {
        const pending = getApprovalInfoByConversation(conversationId);
        if (pending.length === 0 || !pending.some(p => p.requestId === cbDecision.requestId)) {
          log.warn(
            { conversationId, callbackRequestId: cbDecision.requestId },
            'Callback request ID does not match any pending interaction, ignoring stale button press',
          );
          return { handled: true, type: 'stale_ignored' };
        }
      }

      const result = handleChannelDecision(conversationId, cbDecision);

      if (result.applied) {
        // Post-decision delivery is handled by the onEvent callback
        // in the session that registered the pending interaction.
        return { handled: true, type: 'decision_applied' };
      }

      // Race condition: request was already resolved between the stale check
      // above and the decision attempt.
      return { handled: true, type: 'stale_ignored' };
    }
  }

  // ── Conversational approval engine for plain-text messages ──
  // Instead of deterministic keyword matching and reminder prompts, delegate
  // to the conversational approval engine which can classify natural language
  // and respond conversationally.
  const pending = getApprovalInfoByConversation(conversationId);
  if (pending.length > 0 && approvalConversationGenerator && content) {
    const allowedActions = pendingPrompt.actions.map((a) => a.id);
    const engineContext: ApprovalConversationContext = {
      toolName: pending[0].toolName,
      allowedActions,
      role: 'requester',
      pendingApprovals: pending.map((p) => ({ requestId: p.requestId, toolName: p.toolName })),
      userMessage: content,
    };

    const engineResult = await runApprovalConversationTurn(engineContext, approvalConversationGenerator);

    if (engineResult.disposition === 'keep_pending') {
      // Non-decision follow-up — deliver the engine's reply and keep the request pending
      try {
        await deliverChannelReply(replyCallbackUrl, {
          chatId: externalChatId,
          text: engineResult.replyText,
          assistantId,
        }, bearerToken);
      } catch (err) {
        log.error({ err, conversationId }, 'Failed to deliver approval conversation reply');
      }
      return { handled: true, type: 'assistant_turn' };
    }

    // Decision-bearing disposition — map to ApprovalDecisionResult and apply
    const decisionAction = engineResult.disposition as 'approve_once' | 'approve_always' | 'reject';
    const engineDecision: ApprovalDecisionResult = {
      action: decisionAction,
      source: 'plain_text',
      ...(engineResult.targetRequestId ? { requestId: engineResult.targetRequestId } : {}),
    };

    const result = handleChannelDecision(conversationId, engineDecision);

    if (result.applied) {
      // Deliver the engine's reply text to the user
      try {
        await deliverChannelReply(replyCallbackUrl, {
          chatId: externalChatId,
          text: engineResult.replyText,
          assistantId,
        }, bearerToken);
      } catch (err) {
        log.error({ err, conversationId }, 'Failed to deliver approval decision reply');
      }

      return { handled: true, type: 'decision_applied' };
    }

    // Race condition: request was already resolved by expiry sweep or
    // concurrent callback. Deliver a stale notice instead of the
    // engine's optimistic reply.
    try {
      const staleText = await composeApprovalMessageGenerative({
        scenario: 'approval_already_resolved',
        channel: sourceChannel,
      }, {}, approvalCopyGenerator);
      await deliverChannelReply(replyCallbackUrl, {
        chatId: externalChatId,
        text: staleText,
        assistantId,
      }, bearerToken);
    } catch (err) {
      log.error({ err, conversationId }, 'Failed to deliver stale approval notice');
    }

    return { handled: true, type: 'stale_ignored' };
  }

  // Fallback: no conversational generator available or no content — use
  // the legacy deterministic path as a safety net. This preserves backward
  // compatibility when the generator is not injected.
  if (content) {
    const legacyDecision = parseApprovalDecision(content);
    if (legacyDecision) {
      if (legacyDecision.requestId) {
        if (pending.length === 0 || !pending.some(p => p.requestId === legacyDecision.requestId)) {
          return { handled: true, type: 'stale_ignored' };
        }
      }
      const result = handleChannelDecision(conversationId, legacyDecision);
      if (result.applied) {
        return { handled: true, type: 'decision_applied' };
      }

      // Race condition: request was already resolved.
      try {
        const staleText = await composeApprovalMessageGenerative({
          scenario: 'approval_already_resolved',
          channel: sourceChannel,
        }, {}, approvalCopyGenerator);
        await deliverChannelReply(replyCallbackUrl, {
          chatId: externalChatId,
          text: staleText,
          assistantId,
        }, bearerToken);
      } catch (err) {
        log.error({ err, conversationId }, 'Failed to deliver stale approval notice (legacy path)');
      }
      return { handled: true, type: 'stale_ignored' };
    }
  }

  // No decision could be extracted and no conversational engine is available —
  // deliver a simple status reply rather than a reminder prompt.
  try {
    const statusText = await composeApprovalMessageGenerative({
      scenario: 'reminder_prompt',
      channel: sourceChannel,
      toolName: pending.length > 0 ? pending[0].toolName : undefined,
    }, {}, approvalCopyGenerator);
    await deliverChannelReply(replyCallbackUrl, {
      chatId: externalChatId,
      text: statusText,
      assistantId,
    }, bearerToken);
  } catch (err) {
    log.error({ err, conversationId }, 'Failed to deliver approval status reply');
  }

  return { handled: true, type: 'assistant_turn' };
}

// ---------------------------------------------------------------------------
// Access request decision helper
// ---------------------------------------------------------------------------

/**
 * Handle a guardian's decision on an `ingress_access_request` approval.
 * Delegates to the access-request-decision module and orchestrates
 * notification delivery.
 *
 * On approve: creates a verification session, delivers the code to the
 * guardian, and notifies the requester to expect a code.
 *
 * On deny: marks the request as denied and notifies the requester.
 */
async function handleAccessRequestApproval(
  approval: GuardianApprovalRequest,
  action: 'approve' | 'deny',
  decidedByExternalUserId: string,
  replyCallbackUrl: string,
  assistantId: string,
  bearerToken?: string,
): Promise<ApprovalInterceptionResult> {
  const decisionResult = handleAccessRequestDecision(
    approval,
    action,
    decidedByExternalUserId,
  );

  if (decisionResult.type === 'stale' || decisionResult.type === 'idempotent') {
    return { handled: true, type: 'stale_ignored' };
  }

  if (decisionResult.type === 'denied') {
    await notifyRequesterOfDenial({
      replyCallbackUrl,
      requesterChatId: approval.requesterChatId,
      assistantId,
      bearerToken,
    });

    // Emit both guardian_decision and denied signals so all lifecycle
    // observers are notified of the denial.
    const deniedPayload = {
      sourceChannel: approval.channel,
      requesterExternalUserId: approval.requesterExternalUserId,
      requesterChatId: approval.requesterChatId,
      decidedByExternalUserId,
      decision: 'denied' as const,
    };

    void emitNotificationSignal({
      sourceEventName: 'ingress.trusted_contact.guardian_decision',
      sourceChannel: approval.channel,
      sourceSessionId: approval.conversationId,
      assistantId,
      attentionHints: {
        requiresAction: false,
        urgency: 'medium',
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: deniedPayload,
      dedupeKey: `trusted-contact:guardian-decision:${approval.id}`,
    });

    void emitNotificationSignal({
      sourceEventName: 'ingress.trusted_contact.denied',
      sourceChannel: approval.channel,
      sourceSessionId: approval.conversationId,
      assistantId,
      attentionHints: {
        requiresAction: false,
        urgency: 'low',
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: deniedPayload,
      dedupeKey: `trusted-contact:denied:${approval.id}`,
    });

    return { handled: true, type: 'guardian_decision_applied' };
  }

  // Approved: deliver the verification code to the guardian and notify the requester.
  const requesterIdentifier = approval.requesterExternalUserId;

  let codeDelivered = true;
  if (decisionResult.verificationCode) {
    const deliveryResult: DeliveryResult = await deliverVerificationCodeToGuardian({
      replyCallbackUrl,
      guardianChatId: approval.guardianChatId,
      requesterIdentifier,
      verificationCode: decisionResult.verificationCode,
      assistantId,
      bearerToken,
    });
    if (!deliveryResult.ok) {
      log.error(
        { reason: deliveryResult.reason, approvalId: approval.id },
        'Skipping requester notification — verification code was not delivered to guardian',
      );
      codeDelivered = false;
    }
  }

  if (codeDelivered) {
    await notifyRequesterOfApproval({
      replyCallbackUrl,
      requesterChatId: approval.requesterChatId,
      assistantId,
      bearerToken,
    });
  } else {
    // Let the requester know something went wrong without revealing details
    await notifyRequesterOfDeliveryFailure({
      replyCallbackUrl,
      requesterChatId: approval.requesterChatId,
      assistantId,
      bearerToken,
    });
  }

  // Don't emit guardian_decision for approvals that still require code
  // verification — the guardian already received the code, and emitting
  // this signal prematurely causes the notification pipeline to deliver
  // a confusing "approved" message before the requester has verified.
  // The guardian_decision signal should only fire once access is fully granted
  // (i.e. after code consumption), which is handled in the verification path.
  if (!decisionResult.verificationSessionId) {
    void emitNotificationSignal({
      sourceEventName: 'ingress.trusted_contact.guardian_decision',
      sourceChannel: approval.channel,
      sourceSessionId: approval.conversationId,
      assistantId,
      attentionHints: {
        requiresAction: false,
        urgency: 'medium',
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: {
        sourceChannel: approval.channel,
        requesterExternalUserId: approval.requesterExternalUserId,
        requesterChatId: approval.requesterChatId,
        decidedByExternalUserId,
        decision: 'approved',
      },
      dedupeKey: `trusted-contact:guardian-decision:${approval.id}`,
    });
  }

  // Emit verification_sent with visibleInSourceNow=true so the notification
  // pipeline suppresses delivery — the guardian already received the
  // verification code directly. Without this flag, the pipeline generates
  // a redundant LLM message like "Good news! Your request has been approved."
  if (decisionResult.verificationSessionId && codeDelivered) {
    void emitNotificationSignal({
      sourceEventName: 'ingress.trusted_contact.verification_sent',
      sourceChannel: approval.channel,
      sourceSessionId: approval.conversationId,
      assistantId,
      attentionHints: {
        requiresAction: false,
        urgency: 'low',
        isAsyncBackground: true,
        visibleInSourceNow: true,
      },
      contextPayload: {
        sourceChannel: approval.channel,
        requesterExternalUserId: approval.requesterExternalUserId,
        requesterChatId: approval.requesterChatId,
        verificationSessionId: decisionResult.verificationSessionId,
      },
      dedupeKey: `trusted-contact:verification-sent:${decisionResult.verificationSessionId}`,
    });
  }

  return { handled: true, type: 'guardian_decision_applied' };
}
