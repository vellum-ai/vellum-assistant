/**
 * Approval interception: checks for pending approvals and handles inbound
 * messages as decisions, reminders, or conversational follow-ups.
 */
import type { ChannelId } from '../../channels/types.js';
import {
  getAllPendingApprovalsByGuardianChat,
  getPendingApprovalByRunAndGuardianChat,
  getPendingApprovalForRun,
  getUnresolvedApprovalForRun,
  updateApprovalDecision,
} from '../../memory/channel-guardian-store.js';
import { getPendingConfirmationsByConversation } from '../../memory/runs-store.js';
import { getLogger } from '../../util/logger.js';
import { runApprovalConversationTurn } from '../approval-conversation-turn.js';
import { composeApprovalMessageGenerative } from '../approval-message-composer.js';
import { parseApprovalDecision } from '../channel-approval-parser.js';
import type {
  ApprovalDecisionResult,
} from '../channel-approval-types.js';
import {
  getChannelApprovalPrompt,
  handleChannelDecision,
} from '../channel-approvals.js';
import { deliverChannelReply } from '../gateway-client.js';
import type {
  ApprovalConversationContext,
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
} from '../http-types.js';
import type { RunOrchestrator } from '../run-orchestrator.js';
import { schedulePostDecisionDelivery } from './channel-delivery-routes.js';
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
  orchestrator: RunOrchestrator;
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
    orchestrator,
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
    guardianCtx.actorRole === 'guardian' &&
    senderExternalUserId
  ) {
    // Callback/button path: deterministic and takes priority.
    let callbackDecision: ApprovalDecisionResult | null = null;
    if (callbackData) {
      callbackDecision = parseCallbackData(callbackData, sourceChannel);
    }

    // When a callback button provides a run ID, use the scoped lookup so
    // the decision resolves to exactly the right approval even when
    // multiple approvals target the same guardian chat.
    let guardianApproval = callbackDecision?.runId
      ? getPendingApprovalByRunAndGuardianChat(callbackDecision.runId, sourceChannel, externalChatId, assistantId)
      : null;

    // When the scoped lookup didn't resolve an approval (either because
    // there was no callback or the runId pointed to a stale/expired run),
    // fall back to checking all pending approvals for this guardian chat.
    if (!guardianApproval && callbackDecision) {
      const allPending = getAllPendingApprovalsByGuardianChat(sourceChannel, externalChatId, assistantId);
      if (allPending.length === 1) {
        guardianApproval = allPending[0];
      } else if (allPending.length > 1) {
        // The callback targeted a stale/expired run but the guardian has other
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
      // actorRole check above already verifies the sender is a guardian,
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
        // approve_always is not available for guardian approvals — guardians
        // should not be able to permanently allowlist tools on behalf of the
        // requester. Downgrade to approve_once.
        if (callbackDecision.action === 'approve_always') {
          callbackDecision = { ...callbackDecision, action: 'approve_once' };
        }

        // Apply the decision to the underlying run using the requester's
        // conversation context
        const result = handleChannelDecision(
          guardianApproval.conversationId,
          callbackDecision,
          orchestrator,
        );

        if (result.applied) {
          // Update the guardian approval request record only when the decision
          // was actually applied. If the run was already resolved (race with
          // expiry sweep or concurrent callback), skip to avoid inconsistency.
          const approvalStatus = callbackDecision.action === 'reject' ? 'denied' as const : 'approved' as const;
          updateApprovalDecision(guardianApproval.id, {
            status: approvalStatus,
            decidedByExternalUserId: senderExternalUserId,
          });

          // Notify the requester's chat about the outcome with the tool name
          const outcomeText = await composeApprovalMessageGenerative({
            scenario: 'guardian_decision_outcome',
            decision: callbackDecision.action === 'reject' ? 'denied' : 'approved',
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

          // Schedule post-decision delivery to the requester's chat in case
          // the original poll has already exited.
          if (result.runId) {
            schedulePostDecisionDelivery(
              orchestrator,
              result.runId,
              guardianApproval.conversationId,
              guardianApproval.requesterChatId,
              replyCallbackUrl,
              bearerToken,
              assistantId,
            );
          }
          return { handled: true, type: 'guardian_decision_applied' };
        }

        // Race condition: callback arrived after run was already resolved.
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
          pendingApprovals: effectivePending.map((a) => ({ runId: a.runId, toolName: a.toolName })),
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

        // Resolve the target approval: use targetRunId from the engine if
        // provided, otherwise use the single guardian approval.
        const targetApproval = engineResult.targetRunId
          ? allGuardianPending.find((a) => a.runId === engineResult.targetRunId) ?? guardianApproval
          : guardianApproval;

        // Re-validate guardian identity against the resolved target. The
        // engine may select a different pending approval (via targetRunId)
        // that was assigned to a different guardian. Without this check a
        // currently bound guardian could act on a request assigned to a
        // previous guardian after a binding rotation.
        if (senderExternalUserId !== targetApproval.guardianExternalUserId) {
          log.warn(
            { externalChatId, senderExternalUserId, expectedGuardian: targetApproval.guardianExternalUserId, targetRunId: engineResult.targetRunId },
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

        const engineDecision: ApprovalDecisionResult = {
          action: decisionAction,
          source: 'plain_text',
          ...(engineResult.targetRunId ? { runId: engineResult.targetRunId } : {}),
        };

        const result = handleChannelDecision(
          targetApproval.conversationId,
          engineDecision,
          orchestrator,
        );

        if (result.applied) {
          // Update the guardian approval request record only when the decision
          // was actually applied. If the run was already resolved (race with
          // expiry sweep or concurrent callback), skip to avoid inconsistency.
          const approvalStatus = decisionAction === 'reject' ? 'denied' as const : 'approved' as const;
          updateApprovalDecision(targetApproval.id, {
            status: approvalStatus,
            decidedByExternalUserId: senderExternalUserId,
          });

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

          // Schedule post-decision delivery to the requester's chat
          if (result.runId) {
            schedulePostDecisionDelivery(
              orchestrator,
              result.runId,
              targetApproval.conversationId,
              targetApproval.requesterChatId,
              replyCallbackUrl,
              bearerToken,
              assistantId,
            );
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

        // Race condition: run was already resolved. Deliver a stale notice
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

          // Resolve the target approval: when a [ref:<runId>] tag is
          // present, look up the specific pending approval by that runId
          // so the decision applies to the correct conversation even when
          // multiple guardian approvals are pending.
          let targetLegacyApproval = guardianApproval;
          if (legacyGuardianDecision.runId) {
            const resolvedByRun = getPendingApprovalByRunAndGuardianChat(
              legacyGuardianDecision.runId,
              sourceChannel,
              externalChatId,
              assistantId,
            );
            if (!resolvedByRun) {
              // The referenced run doesn't match any pending guardian
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
            targetLegacyApproval = resolvedByRun;
          }

          // Re-validate guardian identity against the resolved target.
          // The default guardianApproval was already checked, but a
          // runId-resolved approval may belong to a different guardian.
          if (senderExternalUserId !== targetLegacyApproval.guardianExternalUserId) {
            log.warn(
              { externalChatId, senderExternalUserId, expectedGuardian: targetLegacyApproval.guardianExternalUserId, runId: legacyGuardianDecision.runId },
              'Guardian identity mismatch on legacy run-ref resolved target approval',
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

          const result = handleChannelDecision(
            targetLegacyApproval.conversationId,
            legacyGuardianDecision,
            orchestrator,
          );

          if (result.applied) {
            const approvalStatus = legacyGuardianDecision.action === 'reject' ? 'denied' as const : 'approved' as const;
            updateApprovalDecision(targetLegacyApproval.id, {
              status: approvalStatus,
              decidedByExternalUserId: senderExternalUserId,
            });

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

            if (result.runId) {
              schedulePostDecisionDelivery(
                orchestrator,
                result.runId,
                targetLegacyApproval.conversationId,
                targetLegacyApproval.requesterChatId,
                replyCallbackUrl,
                bearerToken,
                assistantId,
              );
            }

            return { handled: true, type: 'guardian_decision_applied' };
          }

          // Race condition: run was already resolved. Deliver stale notice.
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

  // When the sender is from an unverified channel, auto-deny any pending
  // confirmation and block self-approval.
  if (guardianCtx.actorRole === 'unverified_channel') {
    const pending = getPendingConfirmationsByConversation(conversationId);
    if (pending.length > 0) {
      const denyResult = handleChannelDecision(
        conversationId,
        { action: 'reject', source: 'plain_text' },
        orchestrator,
        buildGuardianDenyContext(
          pending[0].toolName,
          guardianCtx.denialReason ?? 'no_binding',
          sourceChannel,
        ),
      );
      if (denyResult.applied && denyResult.runId) {
        schedulePostDecisionDelivery(
          orchestrator,
          denyResult.runId,
          conversationId,
          externalChatId,
          replyCallbackUrl,
          bearerToken,
          assistantId,
        );
      }
      return { handled: true, type: 'decision_applied' };
    }
  }

  // When the sender is a non-guardian and there's a pending guardian approval
  // for this conversation's run, block self-approval. The non-guardian must
  // wait for the guardian to decide.
  if (guardianCtx.actorRole === 'non-guardian') {
    const pending = getPendingConfirmationsByConversation(conversationId);
    if (pending.length > 0) {
      const guardianApprovalForRun = getPendingApprovalForRun(pending[0].runId);
      if (guardianApprovalForRun) {
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
              pendingApprovals: pending.map(p => ({ runId: p.runId, toolName: p.toolName })),
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
            const cancelApplyResult = handleChannelDecision(conversationId, rejectDecision, orchestrator);
            if (cancelApplyResult.applied) {
              updateApprovalDecision(guardianApprovalForRun.id, {
                status: 'denied',
                decidedByExternalUserId: senderExternalUserId,
              });

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
                  chatId: guardianApprovalForRun.guardianChatId,
                  text: guardianNotice,
                  assistantId,
                }, bearerToken);
              } catch (err) {
                log.error({ err, conversationId }, 'Failed to notify guardian of requester cancellation');
              }

              if (cancelApplyResult.runId) {
                schedulePostDecisionDelivery(
                  orchestrator, cancelApplyResult.runId, conversationId, externalChatId,
                  replyCallbackUrl, bearerToken, assistantId,
                );
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
      // expired without a guardian decision, auto-deny the run and transition
      // the approval to 'expired'. Without this, the requester could bypass
      // guardian-only controls by simply waiting for the TTL to elapse.
      const unresolvedApproval = getUnresolvedApprovalForRun(pending[0].runId);
      if (unresolvedApproval) {
        updateApprovalDecision(unresolvedApproval.id, { status: 'expired' });

        // Auto-deny the underlying run so it does not remain actionable
        const expiredDecision: ApprovalDecisionResult = {
          action: 'reject',
          source: 'plain_text',
        };
        handleChannelDecision(conversationId, expiredDecision, orchestrator);

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
    }
  }

  // Try to extract a decision from callback data (button press) first.
  // Callback/button path remains deterministic and takes priority.
  if (callbackData) {
    const cbDecision = parseCallbackData(callbackData, sourceChannel);
    if (cbDecision) {
      // When the decision came from a callback button, validate that the embedded
      // run ID matches the currently pending run. A stale button (from a previous
      // approval prompt) must not apply to a different pending run.
      if (cbDecision.runId) {
        const pending = getPendingConfirmationsByConversation(conversationId);
        if (pending.length === 0 || pending[0].runId !== cbDecision.runId) {
          log.warn(
            { conversationId, callbackRunId: cbDecision.runId, pendingRunId: pending[0]?.runId },
            'Callback run ID does not match pending run, ignoring stale button press',
          );
          return { handled: true, type: 'stale_ignored' };
        }
      }

      const result = handleChannelDecision(conversationId, cbDecision, orchestrator);

      if (result.applied) {
        // Schedule a background poll for run terminal state and deliver the reply.
        // This handles the case where the original poll in
        // processChannelMessageWithApprovals has already exited due to timeout.
        // The claimRunDelivery guard ensures at-most-once delivery when both
        // pollers race to terminal state.
        if (result.runId) {
          schedulePostDecisionDelivery(
            orchestrator,
            result.runId,
            conversationId,
            externalChatId,
            replyCallbackUrl,
            bearerToken,
            assistantId,
          );
        }
        return { handled: true, type: 'decision_applied' };
      }

      // Race condition: run was already resolved between the stale check
      // above and the decision attempt.
      return { handled: true, type: 'stale_ignored' };
    }
  }

  // ── Conversational approval engine for plain-text messages ──
  // Instead of deterministic keyword matching and reminder prompts, delegate
  // to the conversational approval engine which can classify natural language
  // and respond conversationally.
  const pending = getPendingConfirmationsByConversation(conversationId);
  if (pending.length > 0 && approvalConversationGenerator && content) {
    const allowedActions = pendingPrompt.actions.map((a) => a.id);
    const engineContext: ApprovalConversationContext = {
      toolName: pending[0].toolName,
      allowedActions,
      role: 'requester',
      pendingApprovals: pending.map((p) => ({ runId: p.runId, toolName: p.toolName })),
      userMessage: content,
    };

    const engineResult = await runApprovalConversationTurn(engineContext, approvalConversationGenerator);

    if (engineResult.disposition === 'keep_pending') {
      // Non-decision follow-up — deliver the engine's reply and keep the run pending
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
      ...(engineResult.targetRunId ? { runId: engineResult.targetRunId } : {}),
    };

    const result = handleChannelDecision(conversationId, engineDecision, orchestrator);

    if (result.applied) {
      if (result.runId) {
        schedulePostDecisionDelivery(
          orchestrator,
          result.runId,
          conversationId,
          externalChatId,
          replyCallbackUrl,
          bearerToken,
          assistantId,
        );
      }

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

    // Race condition: run was already resolved by expiry sweep or
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
      if (legacyDecision.runId) {
        if (pending.length === 0 || pending[0].runId !== legacyDecision.runId) {
          return { handled: true, type: 'stale_ignored' };
        }
      }
      const result = handleChannelDecision(conversationId, legacyDecision, orchestrator);
      if (result.applied) {
        if (result.runId) {
          schedulePostDecisionDelivery(
            orchestrator,
            result.runId,
            conversationId,
            externalChatId,
            replyCallbackUrl,
            bearerToken,
            assistantId,
          );
        }
        return { handled: true, type: 'decision_applied' };
      }

      // Race condition: run was already resolved.
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
