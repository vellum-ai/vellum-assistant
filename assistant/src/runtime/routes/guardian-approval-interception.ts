/**
 * Approval interception: checks for pending approvals and handles inbound
 * messages as decisions, reminders, or conversational follow-ups.
 *
 * This module is the top-level dispatcher. It delegates to strategy modules:
 * - guardian-callback-strategy.ts   — guardian callback button and text decisions
 * - guardian-text-engine-strategy.ts — conversational engine for plain-text messages
 */
import { applyGuardianDecision } from "../../approvals/guardian-decision-primitive.js";
import type { ChannelId } from "../../channels/types.js";
import type { TrustContext } from "../../daemon/session-runtime-assembly.js";
import {
  getPendingApprovalForRequest,
  getUnresolvedApprovalForRequest,
  updateApprovalDecision,
} from "../../memory/guardian-approvals.js";
import { getLogger } from "../../util/logger.js";
import { runApprovalConversationTurn } from "../approval-conversation-turn.js";
import { composeApprovalMessageGenerative } from "../approval-message-composer.js";
import type { ApprovalDecisionResult } from "../channel-approval-types.js";
import {
  getApprovalInfoByConversation,
  getChannelApprovalPrompt,
  handleChannelDecision,
} from "../channel-approvals.js";
import { deliverChannelReply } from "../gateway-client.js";
import type {
  ApprovalConversationContext,
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
} from "../http-types.js";
import { parseApprovalIntent } from "../nl-approval-parser.js";
import { handleGuardianCallbackDecision } from "./approval-strategies/guardian-callback-strategy.js";
import { handleGuardianTextEngineDecision } from "./approval-strategies/guardian-text-engine-strategy.js";
import {
  buildGuardianDenyContext,
  parseCallbackData,
  parseReactionCallbackData,
} from "./channel-route-shared.js";
import { deliverStaleApprovalReply } from "./guardian-approval-reply-helpers.js";

const log = getLogger("runtime-http");

export interface ApprovalInterceptionParams {
  conversationId: string;
  callbackData?: string;
  content: string;
  conversationExternalId: string;
  sourceChannel: ChannelId;
  actorExternalId?: string;
  replyCallbackUrl: string;
  bearerToken?: string;
  trustCtx: TrustContext;
  assistantId: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  approvalConversationGenerator?: ApprovalConversationGenerator;
}

export interface ApprovalInterceptionResult {
  handled: boolean;
  type?:
    | "decision_applied"
    | "assistant_turn"
    | "guardian_decision_applied"
    | "stale_ignored";
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
    conversationExternalId,
    sourceChannel,
    actorExternalId,
    replyCallbackUrl,
    bearerToken,
    trustCtx,
    assistantId,
    approvalCopyGenerator,
    approvalConversationGenerator,
  } = params;

  // ── Guardian approval decision path ──
  // When the sender is the guardian and there's a pending guardian approval
  // request targeting this chat, the message might be a decision on behalf
  // of a non-guardian requester. Delegated to the guardian callback strategy.
  if (trustCtx.trustClass === "guardian" && actorExternalId) {
    const guardianResult = await handleGuardianCallbackDecision({
      content,
      callbackData,
      conversationExternalId,
      sourceChannel,
      actorExternalId,
      replyCallbackUrl,
      bearerToken,
      assistantId,
      approvalCopyGenerator,
      approvalConversationGenerator: approvalConversationGenerator!,
    });
    if (guardianResult) {
      return guardianResult;
    }
  }

  // ── Slack reaction path ──
  // Reactions produce `callbackData` of the form `reaction:<emoji_name>`.
  // Handled before the pendingPrompt guard because guardian reactions arrive
  // on the guardian's chat (guardianChatId), not the requester's conversation,
  // so getChannelApprovalPrompt(conversationId) would return null.
  // Only guardians can approve via reaction — non-guardian reactions are
  // silently ignored to prevent self-approval.
  if (callbackData?.startsWith("reaction:")) {
    if (trustCtx.trustClass !== "guardian") {
      return { handled: true, type: "stale_ignored" };
    }
    const reactionDecision = parseReactionCallbackData(callbackData);
    if (!reactionDecision) {
      // Unknown emoji — ignore silently
      return { handled: true, type: "stale_ignored" };
    }
    const pending = getApprovalInfoByConversation(conversationId);
    if (pending.length === 0) {
      return { handled: true, type: "stale_ignored" };
    }
    const result = handleChannelDecision(conversationId, reactionDecision);
    if (result.applied) {
      return { handled: true, type: "decision_applied" };
    }
    return { handled: true, type: "stale_ignored" };
  }

  // ── Standard approval interception (existing flow) ──
  const pendingPrompt = getChannelApprovalPrompt(conversationId);
  if (!pendingPrompt) return { handled: false };

  // Unverified sender: unknown trust where either the sender's identity
  // could not be established or no guardian binding exists for the channel.
  // Identity-known non-member senders in shared channels (unknown trust with
  // both identity and guardian binding present) must not force-reject.
  const isUnverifiedSender =
    trustCtx.trustClass === "unknown" &&
    (!trustCtx.requesterExternalUserId || !trustCtx.guardianExternalUserId);

  // When the sender is unverified, auto-deny any pending confirmation and
  // block self-approval.
  if (isUnverifiedSender) {
    const pending = getApprovalInfoByConversation(conversationId);
    if (pending.length > 0) {
      const reason: "no_identity" | "no_binding" =
        !trustCtx.requesterExternalUserId ? "no_identity" : "no_binding";
      handleChannelDecision(
        conversationId,
        { action: "reject", source: "plain_text" },
        buildGuardianDenyContext(pending[0].toolName, reason, sourceChannel),
      );
      return { handled: true, type: "decision_applied" };
    }
  }

  // When the sender is a non-guardian with established identity and a guardian
  // binding, block self-approval. The non-guardian must wait for the guardian
  // to decide. This covers trusted contacts and identity-known non-member
  // senders in shared channels.
  const isIdentityKnownNonGuardian =
    trustCtx.trustClass === "trusted_contact" ||
    (trustCtx.trustClass === "unknown" &&
      !!trustCtx.requesterExternalUserId &&
      !!trustCtx.guardianExternalUserId);
  if (isIdentityKnownNonGuardian) {
    const pending = getApprovalInfoByConversation(conversationId);
    if (pending.length > 0) {
      const guardianApprovalForRequest = getPendingApprovalForRequest(
        pending[0].requestId,
      );
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
              allowedActions: ["reject"],
              role: "requester",
              pendingApprovals: pending.map((p) => ({
                requestId: p.requestId,
                toolName: p.toolName,
              })),
              userMessage: content,
            };
            const cancelResult = await runApprovalConversationTurn(
              cancelContext,
              approvalConversationGenerator,
            );
            if (cancelResult.disposition === "reject") {
              requesterCancelIntent = true;
              cancelReplyText = cancelResult.replyText;
            } else if (cancelResult.disposition === "keep_pending") {
              requesterFollowupReplyText = cancelResult.replyText;
            }
          }

          if (requesterCancelIntent) {
            const rejectDecision: ApprovalDecisionResult = {
              action: "reject",
              source: "plain_text",
            };
            // Apply the cancel decision through the unified primitive.
            // The primitive handles record update and (no-op) grant logic.
            const cancelApplyResult = applyGuardianDecision({
              approval: guardianApprovalForRequest,
              decision: rejectDecision,
              actorPrincipalId: undefined, // Interception path — principal not available
              actorExternalUserId: actorExternalId, // Channel-native ID
              actorChannel: sourceChannel,
            });
            if (cancelApplyResult.applied) {
              // Notify requester
              const replyText =
                cancelReplyText ??
                (await composeApprovalMessageGenerative(
                  {
                    scenario: "requester_cancel",
                    toolName: pending[0].toolName,
                    channel: sourceChannel,
                  },
                  {},
                  approvalCopyGenerator,
                ));
              try {
                await deliverChannelReply(
                  replyCallbackUrl,
                  {
                    chatId: conversationExternalId,
                    text: replyText,
                    assistantId,
                  },
                  bearerToken,
                );
              } catch (err) {
                log.error(
                  { err, conversationId },
                  "Failed to deliver requester cancel notice",
                );
              }

              // Notify guardian that the request was cancelled
              try {
                const guardianNotice = await composeApprovalMessageGenerative(
                  {
                    scenario: "guardian_decision_outcome",
                    decision: "denied",
                    toolName: pending[0].toolName,
                    channel: sourceChannel,
                  },
                  {},
                  approvalCopyGenerator,
                );
                await deliverChannelReply(
                  replyCallbackUrl,
                  {
                    chatId: guardianApprovalForRequest.guardianChatId,
                    text: guardianNotice,
                    assistantId,
                  },
                  bearerToken,
                );
              } catch (err) {
                log.error(
                  { err, conversationId },
                  "Failed to notify guardian of requester cancellation",
                );
              }

              return { handled: true, type: "decision_applied" };
            }

            // Race condition: approval was already resolved elsewhere.
            await deliverStaleApprovalReply({
              scenario: "approval_already_resolved",
              sourceChannel,
              replyCallbackUrl,
              chatId: conversationExternalId,
              assistantId,
              bearerToken,
              approvalCopyGenerator,
              logger: log,
              errorLogMessage:
                "Failed to deliver stale requester-cancel notice",
              errorLogContext: { conversationId },
            });
            return { handled: true, type: "stale_ignored" };
          }

          if (requesterFollowupReplyText) {
            try {
              await deliverChannelReply(
                replyCallbackUrl,
                {
                  chatId: conversationExternalId,
                  text: requesterFollowupReplyText,
                  assistantId,
                },
                bearerToken,
              );
            } catch (err) {
              log.error(
                { err, conversationId },
                "Failed to deliver requester follow-up reply while awaiting guardian",
              );
            }
            return { handled: true, type: "assistant_turn" };
          }
        }

        // Not a cancel intent — tell the requester their request is pending
        await deliverStaleApprovalReply({
          scenario: "request_pending_guardian",
          sourceChannel,
          replyCallbackUrl,
          chatId: conversationExternalId,
          assistantId,
          bearerToken,
          approvalCopyGenerator,
          logger: log,
          errorLogMessage:
            "Failed to deliver guardian-pending notice to requester",
          errorLogContext: { conversationId },
        });
        return { handled: true, type: "assistant_turn" };
      }

      // Check for an expired-but-unresolved guardian approval. If the approval
      // expired without a guardian decision, auto-deny and transition
      // the approval to 'expired'. Without this, the requester could bypass
      // guardian-only controls by simply waiting for the TTL to elapse.
      const unresolvedApproval = getUnresolvedApprovalForRequest(
        pending[0].requestId,
      );
      if (unresolvedApproval) {
        updateApprovalDecision(unresolvedApproval.id, { status: "expired" });

        // Auto-deny the underlying request so it does not remain actionable
        const expiredDecision: ApprovalDecisionResult = {
          action: "reject",
          source: "plain_text",
        };
        handleChannelDecision(conversationId, expiredDecision);

        await deliverStaleApprovalReply({
          scenario: "guardian_expired_requester",
          sourceChannel,
          replyCallbackUrl,
          chatId: conversationExternalId,
          assistantId,
          bearerToken,
          approvalCopyGenerator,
          logger: log,
          errorLogMessage:
            "Failed to deliver guardian-expiry notice to requester",
          extraContext: { toolName: pending[0].toolName },
          errorLogContext: { conversationId },
        });
        return { handled: true, type: "decision_applied" };
      }

      // Guard: non-guardian actors with a guardian binding must not self-approve
      // even when no guardian approval row exists yet. The guardian approval
      // row is created asynchronously when the approval prompt is delivered
      // to the guardian. In the window between the pending confirmation being
      // created (isInteractive=true) and the guardian approval row being
      // persisted, any non-guardian actor could otherwise fall through to the
      // standard conversational engine / legacy parser and resolve their own
      // pending request via handleChannelDecision.
      if (
        trustCtx.trustClass !== "guardian" &&
        trustCtx.guardianExternalUserId
      ) {
        log.info(
          {
            conversationId,
            conversationExternalId,
            guardianExternalUserId: trustCtx.guardianExternalUserId,
          },
          "Blocking non-guardian self-approval: pending confirmation exists but guardian approval row not yet created",
        );
        await deliverStaleApprovalReply({
          scenario: "request_pending_guardian",
          sourceChannel,
          replyCallbackUrl,
          chatId: conversationExternalId,
          assistantId,
          bearerToken,
          approvalCopyGenerator,
          logger: log,
          errorLogMessage:
            "Failed to deliver guardian-pending notice to non-guardian actor (pre-row guard)",
          errorLogContext: { conversationId },
        });
        return { handled: true, type: "assistant_turn" };
      }
    }
  }

  // ── Slack reaction path ──
  // Reactions produce `callbackData` of the form `reaction:<emoji_name>`.
  // Only guardians can approve via reaction — non-guardian reactions are
  // silently ignored to prevent self-approval.
  if (callbackData?.startsWith("reaction:")) {
    if (trustCtx.trustClass !== "guardian") {
      return { handled: true, type: "stale_ignored" };
    }
    const reactionDecision = parseReactionCallbackData(callbackData);
    if (!reactionDecision) {
      // Unknown emoji — ignore silently
      return { handled: true, type: "stale_ignored" };
    }
    const pending = getApprovalInfoByConversation(conversationId);
    if (pending.length === 0) {
      return { handled: true, type: "stale_ignored" };
    }
    const result = handleChannelDecision(conversationId, reactionDecision);
    if (result.applied) {
      return { handled: true, type: "decision_applied" };
    }
    return { handled: true, type: "stale_ignored" };
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
        if (
          pending.length === 0 ||
          !pending.some((p) => p.requestId === cbDecision.requestId)
        ) {
          log.warn(
            { conversationId, callbackRequestId: cbDecision.requestId },
            "Callback request ID does not match any pending interaction, ignoring stale button press",
          );
          return { handled: true, type: "stale_ignored" };
        }
      }

      const result = handleChannelDecision(conversationId, cbDecision);

      if (result.applied) {
        // Post-decision delivery is handled by the onEvent callback
        // in the session that registered the pending interaction.
        return { handled: true, type: "decision_applied" };
      }

      // Race condition: request was already resolved between the stale check
      // above and the decision attempt.
      return { handled: true, type: "stale_ignored" };
    }
  }

  // ── Conversational approval engine for plain-text messages ──
  // Delegates to the text engine strategy which classifies natural language
  // and responds conversationally.
  const pending = getApprovalInfoByConversation(conversationId);
  if (pending.length > 0 && approvalConversationGenerator && content) {
    const allowedActions = pendingPrompt.actions.map((a) => a.id);
    return handleGuardianTextEngineDecision({
      conversationId,
      conversationExternalId,
      sourceChannel,
      replyCallbackUrl,
      content,
      assistantId,
      bearerToken,
      approvalCopyGenerator,
      approvalConversationGenerator,
      pending,
      allowedActions,
    });
  }

  // ── Natural language approval intent parser ──
  // Covers a broad set of colloquial approval/rejection phrases, emoji, and
  // timed-approval variants for channels (like Slack) that rely on plain-text
  // responses.
  if (pending.length > 0 && content) {
    const nlIntent = parseApprovalIntent(content);
    if (nlIntent && nlIntent.confidence >= 0.9) {
      const nlDecision: ApprovalDecisionResult = {
        action:
          nlIntent.decision === "approve"
            ? "approve_once"
            : nlIntent.decision === "approve_10m"
              ? "approve_10m"
              : "reject",
        source: "plain_text",
      };
      const nlResult = handleChannelDecision(conversationId, nlDecision);
      if (nlResult.applied) {
        return { handled: true, type: "decision_applied" };
      }
    }
  }

  // No decision could be extracted — deliver a simple status reply rather
  // than a reminder prompt.
  await deliverStaleApprovalReply({
    scenario: "reminder_prompt",
    sourceChannel,
    replyCallbackUrl,
    chatId: conversationExternalId,
    assistantId,
    bearerToken,
    approvalCopyGenerator,
    logger: log,
    errorLogMessage: "Failed to deliver approval status reply",
    extraContext: {
      toolName: pending.length > 0 ? pending[0].toolName : undefined,
    },
    errorLogContext: { conversationId },
  });

  return { handled: true, type: "assistant_turn" };
}
