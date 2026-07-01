/**
 * Approval interception: checks for pending approvals and handles inbound
 * messages as decisions, reminders, or conversational follow-ups.
 *
 * This module is the top-level dispatcher. It delegates plain-text messages to
 * the conversational engine in guardian-text-engine-strategy.ts.
 */
import type { KnownBlock } from "@slack/types";

import type { ChannelId } from "../../channels/types.js";
import type { TrustContext } from "../../daemon/trust-context.js";
import { getLogger } from "../../util/logger.js";
import { resolveCapabilities } from "../capabilities.js";
import type { ApprovalDecisionResult } from "../channel-approval-types.js";
import {
  getApprovalInfoByConversation,
  getChannelApprovalPrompt,
  handleChannelDecision,
} from "../channel-approvals.js";
import { deliverChannelReply } from "../gateway-client.js";
import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
} from "../http-types.js";
import { findLocalGuardianPrincipalId } from "../local-actor-identity.js";
import { parseApprovalIntent } from "../nl-approval-parser.js";
import { handleGuardianTextEngineDecision } from "./approval-strategies/guardian-text-engine-strategy.js";
import {
  buildGuardianDenyContext,
  parseCallbackData,
} from "./channel-route-shared.js";
import { deliverStaleApprovalReply } from "./guardian-approval-reply-helpers.js";

const log = getLogger("runtime-http");

/**
 * Resolve the Slack ephemeral user ID when the source channel is Slack.
 * Returns `undefined` for non-Slack channels so callers can pass the
 * result directly to `ephemeralUserId` without branching.
 */
function slackEphemeralUserId(
  sourceChannel: ChannelId,
  userId: string | undefined,
): string | undefined {
  return sourceChannel === "slack" && userId ? userId : undefined;
}

export interface ApprovalInterceptionParams {
  conversationId: string;
  callbackData?: string;
  content: string;
  conversationExternalId: string;
  sourceChannel: ChannelId;
  actorExternalId?: string;
  replyCallbackUrl: string;
  trustCtx: TrustContext;
  assistantId: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  approvalConversationGenerator?: ApprovalConversationGenerator;
  /** Original approval message timestamp (Slack ts) for editing after resolution. */
  approvalMessageTs?: string;
}

import type { ApprovalInterceptionResult } from "./approval-interception-types.js";
export type { ApprovalInterceptionResult } from "./approval-interception-types.js";

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
    trustCtx,
    assistantId,
    approvalCopyGenerator,
    approvalConversationGenerator,
    approvalMessageTs,
  } = params;

  // Slack emoji reactions are handled by the canonical guardian decision
  // pipeline (`routeGuardianReply`), invoked from the inbound reaction stage:
  // it resolves the target request from the reacted card's delivery record.
  // See `guardian-reply-router.ts`.

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
      await handleChannelDecision(
        conversationId,
        { action: "reject", source: "plain_text" },
        buildGuardianDenyContext(pending[0].toolName, reason, sourceChannel),
      );
      return { handled: true, type: "decision_applied" };
    }
  }

  // When the sender is a non-guardian with established identity and a guardian
  // binding, block self-approval. The non-guardian must wait for the guardian
  // to decide. This covers trusted contacts, unverified contacts, and
  // identity-known non-member senders in shared channels.
  const isIdentityKnownNonGuardian =
    resolveCapabilities(trustCtx.trustClass).sensitiveToolApproval ===
      "escalate-and-wait" ||
    (trustCtx.trustClass === "unknown" &&
      !!trustCtx.requesterExternalUserId &&
      !!trustCtx.guardianExternalUserId);
  if (isIdentityKnownNonGuardian) {
    const pending = getApprovalInfoByConversation(conversationId);
    if (pending.length > 0) {
      // Guard: a non-guardian actor with a guardian binding must not
      // self-approve, even in the window before the guardian's canonical
      // request row is persisted. The pending confirmation (isInteractive=true)
      // can exist before the request is delivered to the guardian; without this
      // guard the actor could fall through to the conversational engine / NL
      // parser below and resolve their own pending request via
      // handleChannelDecision.
      if (
        !resolveCapabilities(trustCtx.trustClass).canSelfApproveTools &&
        trustCtx.guardianExternalUserId
      ) {
        log.info(
          {
            conversationId,
            conversationExternalId,
            guardianExternalUserId: trustCtx.guardianExternalUserId,
          },
          "Blocking non-guardian self-approval: pending confirmation exists but canonical guardian request not yet created",
        );
        await deliverStaleApprovalReply({
          scenario: "request_pending_guardian",
          sourceChannel,
          replyCallbackUrl,
          chatId: conversationExternalId,
          assistantId,
          approvalCopyGenerator,
          logger: log,
          errorLogMessage:
            "Failed to deliver guardian-pending notice to non-guardian actor (pre-row guard)",
          errorLogContext: { conversationId },
          ephemeralUserId: slackEphemeralUserId(sourceChannel, actorExternalId),
        });
        return { handled: true, type: "assistant_turn" };
      }
    }
  }

  // ── Guardian principal gate ──
  // A guardian-class decision must be authorized by principal, not merely by
  // the same-channel address match that produced the trust class: the acting
  // principal (the channel binding's principal carried on the trust context)
  // must be present and, when the assistant's vellum anchor resolves, equal
  // it. This runs BEFORE any decision is applied (callback, text engine, NL
  // parser). An unresolvable anchor read (transient gateway miss) defers to
  // the gateway-stamped verdict — the gateway is the ACL source of truth and
  // an absent verdict is already hard-denied at ingress. The failure copy is
  // generic by design: no oracle about pending requests or authorization
  // detail.
  if (trustCtx.trustClass === "guardian") {
    const actingPrincipalId = trustCtx.guardianPrincipalId;
    const anchorPrincipalId = await findLocalGuardianPrincipalId();
    const principalAuthorized =
      !!actingPrincipalId &&
      (!anchorPrincipalId || actingPrincipalId === anchorPrincipalId);
    if (!principalAuthorized) {
      log.warn(
        {
          conversationId,
          sourceChannel,
          hasActingPrincipal: !!actingPrincipalId,
          hasAnchorPrincipal: !!anchorPrincipalId,
        },
        "Blocking guardian-class approval decision: acting principal missing or does not match the bound guardian principal",
      );
      if (replyCallbackUrl) {
        try {
          await deliverChannelReply(replyCallbackUrl, {
            chatId: conversationExternalId,
            text: "Sorry, I couldn't process that. Please try again.",
            assistantId,
            ...(sourceChannel === "slack" && actorExternalId
              ? { ephemeral: true, user: actorExternalId }
              : {}),
          });
        } catch (err) {
          log.error(
            { err, conversationId },
            "Failed to deliver principal-gate rejection reply",
          );
        }
      }
      return { handled: true, type: "stale_ignored" };
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
        if (
          pending.length === 0 ||
          !pending.some((p) => p.requestId === cbDecision.requestId)
        ) {
          log.warn(
            { conversationId, callbackRequestId: cbDecision.requestId },
            "Callback request ID does not match any pending interaction, ignoring stale button press",
          );

          // Edit the original Slack approval message to remove stale buttons
          if (sourceChannel === "slack" && approvalMessageTs) {
            editStaleSlackApprovalMessage({
              replyCallbackUrl,
              chatId: conversationExternalId,
              messageTs: approvalMessageTs,
              assistantId,
              conversationId,
            });
          }

          return { handled: true, type: "stale_ignored" };
        }
      }

      const result = await handleChannelDecision(conversationId, cbDecision);

      if (result.applied) {
        // Edit the original Slack approval message to show the decision
        // and remove stale action buttons.
        if (sourceChannel === "slack" && approvalMessageTs) {
          const decisionOutcome: "approved" | "denied" =
            cbDecision.action === "reject" ? "denied" : "approved";
          const statusEmoji =
            decisionOutcome === "approved" ? "\u2713" : "\u2717";
          const statusLabel =
            decisionOutcome === "approved" ? "Approved" : "Denied";
          deliverChannelReply(replyCallbackUrl, {
            chatId: conversationExternalId,
            text: `${statusEmoji} ${statusLabel}`,
            messageTs: approvalMessageTs,
            assistantId,
          }).catch((err) => {
            log.error(
              { err, conversationId, messageTs: approvalMessageTs },
              "Failed to edit Slack approval message after decision",
            );
          });
        }

        // Post-decision delivery is handled by the onEvent callback
        // in the session that registered the pending interaction.
        return { handled: true, type: "decision_applied" };
      }

      // Race condition: request was already resolved between the stale check
      // above and the decision attempt.
      // Edit the original Slack approval message to remove stale buttons
      if (sourceChannel === "slack" && approvalMessageTs) {
        editStaleSlackApprovalMessage({
          replyCallbackUrl,
          chatId: conversationExternalId,
          messageTs: approvalMessageTs,
          assistantId,
          conversationId,
        });
      }

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
      approvalCopyGenerator,
      approvalConversationGenerator,
      pending,
      allowedActions,
      actorExternalId,
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
        action: nlIntent.decision === "approve" ? "approve_once" : "reject",
        source: "plain_text",
      };
      const nlResult = await handleChannelDecision(conversationId, nlDecision);
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
    approvalCopyGenerator,
    logger: log,
    errorLogMessage: "Failed to deliver approval status reply",
    extraContext: {
      toolName: pending.length > 0 ? pending[0].toolName : undefined,
    },
    errorLogContext: { conversationId },
    ephemeralUserId: slackEphemeralUserId(sourceChannel, actorExternalId),
  });

  return { handled: true, type: "assistant_turn" };
}

// ---------------------------------------------------------------------------
// Slack approval message edit helper
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: edit a stale Slack approval message to indicate it has
 * been resolved and remove the action buttons. Used when a button click
 * arrives for an already-resolved approval.
 */
function editStaleSlackApprovalMessage(params: {
  replyCallbackUrl: string;
  chatId: string;
  messageTs: string;
  assistantId: string;
  conversationId: string;
}): void {
  const statusText = "This approval request has been resolved.";
  const blocks: KnownBlock[] = [
    {
      type: "section",
      text: { type: "mrkdwn", text: statusText },
    },
    {
      type: "context",
      elements: [{ type: "mrkdwn", text: statusText }],
    },
  ];
  deliverChannelReply(params.replyCallbackUrl, {
    chatId: params.chatId,
    text: statusText,
    blocks,
    messageTs: params.messageTs,
    assistantId: params.assistantId,
  }).catch((err) => {
    log.error(
      {
        err,
        conversationId: params.conversationId,
        messageTs: params.messageTs,
      },
      "Failed to edit stale Slack approval message",
    );
  });
}
