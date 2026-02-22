/**
 * Route handlers for channel inbound messages, delivery acks, and
 * conversation deletion.
 */
import { deleteConversationKey } from '../../memory/conversation-key-store.js';
import * as conversationStore from '../../memory/conversation-store.js';
import * as attachmentsStore from '../../memory/attachments-store.js';
import * as channelDeliveryStore from '../../memory/channel-delivery-store.js';
import * as externalConversationStore from '../../memory/external-conversation-store.js';
import { getPendingConfirmationsByConversation } from '../../memory/runs-store.js';
import { renderHistoryContent } from '../../daemon/handlers.js';
import { checkIngressForSecrets } from '../../security/secret-ingress.js';
import { IngressBlockedError } from '../../util/errors.js';
import { getLogger } from '../../util/logger.js';
import {
  getGuardianBinding,
  isGuardian,
  validateAndConsumeChallenge,
} from '../channel-guardian-service.js';
import {
  createApprovalRequest,
  getPendingApprovalByGuardianChat,
  getPendingApprovalForRun,
  updateApprovalDecision,
} from '../../memory/channel-guardian-store.js';
import { deliverChannelReply, deliverApprovalPrompt } from '../gateway-client.js';
import { parseApprovalDecision } from '../channel-approval-parser.js';
import {
  getChannelApprovalPrompt,
  buildApprovalUIMetadata,
  buildGuardianApprovalPrompt,
  handleChannelDecision,
  buildReminderPrompt,
} from '../channel-approvals.js';
import type { ApprovalAction, ApprovalDecisionResult } from '../channel-approval-types.js';
import type { RunOrchestrator } from '../run-orchestrator.js';
import type {
  MessageProcessor,
  RuntimeAttachmentMetadata,
} from '../http-types.js';

const log = getLogger('runtime-http');

// ---------------------------------------------------------------------------
// Actor role
// ---------------------------------------------------------------------------

export type ActorRole = 'guardian' | 'non-guardian';

export interface GuardianContext {
  actorRole: ActorRole;
  /** The guardian's delivery chat ID (from the guardian binding). */
  guardianChatId?: string;
  /** The guardian's external user ID. */
  guardianExternalUserId?: string;
  /** Display identifier for the requester (username or external user ID). */
  requesterIdentifier?: string;
  /** The requester's external user ID. */
  requesterExternalUserId?: string;
  /** The requester's chat ID. */
  requesterChatId?: string;
}

/** Guardian approval request expiry (30 minutes). */
const GUARDIAN_APPROVAL_TTL_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Feature flag
// ---------------------------------------------------------------------------

export function isChannelApprovalsEnabled(): boolean {
  return process.env.CHANNEL_APPROVALS_ENABLED === 'true';
}

// ---------------------------------------------------------------------------
// Callback data parser — format: "apr:<runId>:<action>"
// ---------------------------------------------------------------------------

const VALID_ACTIONS: ReadonlySet<string> = new Set<string>([
  'approve_once',
  'approve_always',
  'reject',
]);

function parseCallbackData(data: string): ApprovalDecisionResult | null {
  const parts = data.split(':');
  if (parts.length < 3 || parts[0] !== 'apr') return null;
  const runId = parts[1];
  const action = parts.slice(2).join(':');
  if (!runId || !VALID_ACTIONS.has(action)) return null;
  return { action: action as ApprovalAction, source: 'telegram_button', runId };
}

export async function handleDeleteConversation(req: Request): Promise<Response> {
  const body = await req.json() as {
    sourceChannel?: string;
    externalChatId?: string;
  };

  const { sourceChannel, externalChatId } = body;

  if (!sourceChannel || typeof sourceChannel !== 'string') {
    return Response.json({ error: 'sourceChannel is required' }, { status: 400 });
  }
  if (!externalChatId || typeof externalChatId !== 'string') {
    return Response.json({ error: 'externalChatId is required' }, { status: 400 });
  }

  const conversationKey = `${sourceChannel}:${externalChatId}`;
  deleteConversationKey(conversationKey);
  externalConversationStore.deleteBindingByChannelChat(sourceChannel, externalChatId);

  return Response.json({ ok: true });
}

export async function handleChannelInbound(
  req: Request,
  processMessage?: MessageProcessor,
  bearerToken?: string,
  runOrchestrator?: RunOrchestrator,
): Promise<Response> {
  const body = await req.json() as {
    sourceChannel?: string;
    externalChatId?: string;
    externalMessageId?: string;
    content?: string;
    isEdit?: boolean;
    senderName?: string;
    attachmentIds?: string[];
    senderExternalUserId?: string;
    senderUsername?: string;
    sourceMetadata?: Record<string, unknown>;
    replyCallbackUrl?: string;
    callbackQueryId?: string;
    callbackData?: string;
  };

  const {
    sourceChannel,
    externalChatId,
    externalMessageId,
    content,
    isEdit,
    attachmentIds,
    sourceMetadata,
  } = body;

  if (!sourceChannel || typeof sourceChannel !== 'string') {
    return Response.json({ error: 'sourceChannel is required' }, { status: 400 });
  }
  if (!externalChatId || typeof externalChatId !== 'string') {
    return Response.json({ error: 'externalChatId is required' }, { status: 400 });
  }
  if (!externalMessageId || typeof externalMessageId !== 'string') {
    return Response.json({ error: 'externalMessageId is required' }, { status: 400 });
  }

  // Reject non-string content regardless of whether attachments are present.
  if (content !== undefined && content !== null && typeof content !== 'string') {
    return Response.json({ error: 'content must be a string' }, { status: 400 });
  }

  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;

  const hasCallbackData = typeof body.callbackData === 'string' && body.callbackData.length > 0;

  if (trimmedContent.length === 0 && !hasAttachments && !isEdit && !hasCallbackData) {
    return Response.json({ error: 'content or attachmentIds is required' }, { status: 400 });
  }

  if (hasAttachments) {
    const resolved = attachmentsStore.getAttachmentsByIds(attachmentIds);
    if (resolved.length !== attachmentIds.length) {
      const resolvedIds = new Set(resolved.map((a) => a.id));
      const missing = attachmentIds.filter((id) => !resolvedIds.has(id));
      return Response.json(
        { error: `Attachment IDs not found: ${missing.join(', ')}` },
        { status: 400 },
      );
    }
  }

  const sourceMessageId = typeof sourceMetadata?.messageId === 'string'
    ? sourceMetadata.messageId
    : undefined;

  if (isEdit && !sourceMessageId) {
    return Response.json({ error: 'sourceMetadata.messageId is required for edits' }, { status: 400 });
  }

  // ── Edit path: update existing message content, no new agent loop ──
  if (isEdit && sourceMessageId) {
    // Dedup the edit event itself (retried edited_message webhooks)
    const editResult = channelDeliveryStore.recordInbound(
      sourceChannel,
      externalChatId,
      externalMessageId,
      { sourceMessageId },
    );

    if (editResult.duplicate) {
      return Response.json({
        accepted: true,
        duplicate: true,
        eventId: editResult.eventId,
      });
    }

    // Retry lookup a few times — the original message may still be processing
    // (linkMessage hasn't been called yet). Short backoff avoids losing edits
    // that arrive while the original agent loop is in progress.
    const EDIT_LOOKUP_RETRIES = 5;
    const EDIT_LOOKUP_DELAY_MS = 2000;

    let original: { messageId: string; conversationId: string } | null = null;
    for (let attempt = 0; attempt <= EDIT_LOOKUP_RETRIES; attempt++) {
      original = channelDeliveryStore.findMessageBySourceId(
        sourceChannel,
        externalChatId,
        sourceMessageId,
      );
      if (original) break;
      if (attempt < EDIT_LOOKUP_RETRIES) {
        log.info(
          { assistantId: "self", sourceMessageId, attempt: attempt + 1, maxAttempts: EDIT_LOOKUP_RETRIES },
          'Original message not linked yet, retrying edit lookup',
        );
        await new Promise((resolve) => setTimeout(resolve, EDIT_LOOKUP_DELAY_MS));
      }
    }

    if (original) {
      conversationStore.updateMessageContent(original.messageId, content ?? '');
      log.info(
        { assistantId: "self", sourceMessageId, messageId: original.messageId },
        'Updated message content from edited_message',
      );
    } else {
      log.warn(
        { assistantId: "self", sourceChannel, externalChatId, sourceMessageId },
        'Could not find original message for edit after retries, ignoring',
      );
    }

    return Response.json({
      accepted: true,
      duplicate: false,
      eventId: editResult.eventId,
    });
  }

  // ── New message path ──
  const result = channelDeliveryStore.recordInbound(
    sourceChannel,
    externalChatId,
    externalMessageId,
    { sourceMessageId },
  );

  // Upsert external conversation binding with sender metadata
  externalConversationStore.upsertBinding({
    conversationId: result.conversationId,
    sourceChannel,
    externalChatId,
    externalUserId: body.senderExternalUserId ?? null,
    displayName: body.senderName ?? null,
    username: body.senderUsername ?? null,
  });

  const metadataHintsRaw = sourceMetadata?.hints;
  const metadataHints = Array.isArray(metadataHintsRaw)
    ? metadataHintsRaw.filter((hint): hint is string => typeof hint === 'string' && hint.trim().length > 0)
    : [];
  const metadataUxBrief = typeof sourceMetadata?.uxBrief === 'string' && sourceMetadata.uxBrief.trim().length > 0
    ? sourceMetadata.uxBrief.trim()
    : undefined;

  const replyCallbackUrl = body.replyCallbackUrl;

  // ── Guardian verification command intercept ──
  // Handled before normal message processing so it never enters the agent loop.
  if (
    !result.duplicate &&
    trimmedContent.startsWith('/guardian_verify ') &&
    replyCallbackUrl &&
    body.senderExternalUserId
  ) {
    const token = trimmedContent.slice('/guardian_verify '.length).trim();
    if (token.length > 0) {
      const verifyResult = validateAndConsumeChallenge(
        'self',
        sourceChannel,
        token,
        body.senderExternalUserId,
        externalChatId,
      );

      const replyText = verifyResult.success
        ? 'Guardian verified successfully. Your identity is now linked to this bot.'
        : 'Verification failed. The code may be invalid or expired.';

      try {
        await deliverChannelReply(replyCallbackUrl, {
          chatId: externalChatId,
          text: replyText,
        }, bearerToken);
      } catch (err) {
        log.error({ err, externalChatId }, 'Failed to deliver guardian verification reply');
      }

      return Response.json({
        accepted: true,
        duplicate: false,
        eventId: result.eventId,
        guardianVerification: verifyResult.success ? 'verified' : 'failed',
      });
    }
  }

  // ── Actor role resolution ──
  // Determine whether the sender is the guardian for this channel.
  // When a guardian binding exists, non-guardian actors get stricter
  // side-effect controls and their approvals route to the guardian's chat.
  let guardianCtx: GuardianContext = { actorRole: 'guardian' };
  if (isChannelApprovalsEnabled() && body.senderExternalUserId) {
    const senderIsGuardian = isGuardian('self', sourceChannel, body.senderExternalUserId);
    if (!senderIsGuardian) {
      const binding = getGuardianBinding('self', sourceChannel);
      if (binding) {
        const requesterLabel = body.senderUsername
          ? `@${body.senderUsername}`
          : body.senderExternalUserId;
        guardianCtx = {
          actorRole: 'non-guardian',
          guardianChatId: binding.guardianDeliveryChatId,
          guardianExternalUserId: binding.guardianExternalUserId,
          requesterIdentifier: requesterLabel,
          requesterExternalUserId: body.senderExternalUserId,
          requesterChatId: externalChatId,
        };
      }
    }
  }

  // ── Approval interception (gated behind feature flag) ──
  if (
    isChannelApprovalsEnabled() &&
    runOrchestrator &&
    replyCallbackUrl &&
    !result.duplicate
  ) {
    const approvalResult = await handleApprovalInterception({
      conversationId: result.conversationId,
      callbackData: body.callbackData,
      content: trimmedContent,
      externalChatId,
      sourceChannel,
      senderExternalUserId: body.senderExternalUserId,
      replyCallbackUrl,
      bearerToken,
      orchestrator: runOrchestrator,
      guardianCtx,
    });

    if (approvalResult.handled) {
      return Response.json({
        accepted: true,
        duplicate: false,
        eventId: result.eventId,
        approval: approvalResult.type,
      });
    }

    // When a callback-only payload (no text content, no attachments) was not
    // handled by approval interception, it's a stale button press with no
    // pending approval. Return early instead of falling through to normal
    // message processing, which would start a run with empty user content.
    if (hasCallbackData && trimmedContent.length === 0 && !hasAttachments) {
      return Response.json({
        accepted: true,
        duplicate: false,
        eventId: result.eventId,
        approval: 'stale_ignored',
      });
    }
  }

  // For new (non-duplicate) messages, run the secret ingress check
  // synchronously, then fire off the agent loop in the background.
  if (!result.duplicate && processMessage) {
    // Persist the raw payload first so dead-lettered events can always be
    // replayed. If the ingress check later detects secrets we clear it
    // before throwing, so secret-bearing content is never left on disk.
    channelDeliveryStore.storePayload(result.eventId, {
      sourceChannel, externalChatId, externalMessageId, content,
      attachmentIds, sourceMetadata: body.sourceMetadata,
      senderName: body.senderName,
      senderExternalUserId: body.senderExternalUserId,
      senderUsername: body.senderUsername,
      replyCallbackUrl,
    });

    const contentToCheck = content ?? '';
    let ingressCheck: ReturnType<typeof checkIngressForSecrets>;
    try {
      ingressCheck = checkIngressForSecrets(contentToCheck);
    } catch (checkErr) {
      channelDeliveryStore.clearPayload(result.eventId);
      throw checkErr;
    }
    if (ingressCheck.blocked) {
      channelDeliveryStore.clearPayload(result.eventId);
      throw new IngressBlockedError(ingressCheck.userNotice!, ingressCheck.detectedTypes);
    }

    // When approval flow is enabled and we have an orchestrator, use the
    // orchestrator-backed path which properly intercepts confirmation_request
    // events and sends proactive approval prompts to the channel.
    const useApprovalPath =
      isChannelApprovalsEnabled() && runOrchestrator && replyCallbackUrl;

    if (useApprovalPath) {
      processChannelMessageWithApprovals({
        orchestrator: runOrchestrator,
        conversationId: result.conversationId,
        eventId: result.eventId,
        content: content ?? '',
        attachmentIds: hasAttachments ? attachmentIds : undefined,
        externalChatId,
        sourceChannel,
        replyCallbackUrl,
        bearerToken,
        guardianCtx,
      });
    } else {
      // Fire-and-forget: process the message and deliver the reply in the background.
      // The HTTP response returns immediately so the gateway webhook is not blocked.
      processChannelMessageInBackground({
        processMessage,
        conversationId: result.conversationId,
        eventId: result.eventId,
        content: content ?? '',
        attachmentIds: hasAttachments ? attachmentIds : undefined,
        sourceChannel,
        externalChatId,
        metadataHints,
        metadataUxBrief,
        replyCallbackUrl,
        bearerToken,
      });
    }
  }

  return Response.json({
    accepted: result.accepted,
    duplicate: result.duplicate,
    eventId: result.eventId,
  });
}

interface BackgroundProcessingParams {
  processMessage: MessageProcessor;
  conversationId: string;
  eventId: string;
  content: string;
  attachmentIds?: string[];
  sourceChannel: string;
  externalChatId: string;
  metadataHints: string[];
  metadataUxBrief?: string;
  replyCallbackUrl?: string;
  bearerToken?: string;
}

function processChannelMessageInBackground(params: BackgroundProcessingParams): void {
  const {
    processMessage,
    conversationId,
    eventId,
    content,
    attachmentIds,
    sourceChannel,
    externalChatId,
    metadataHints,
    metadataUxBrief,
    replyCallbackUrl,
    bearerToken,
  } = params;

  (async () => {
    try {
      const { messageId: userMessageId } = await processMessage(
        conversationId,
        content,
        attachmentIds,
        {
          transport: {
            channelId: sourceChannel,
            hints: metadataHints.length > 0 ? metadataHints : undefined,
            uxBrief: metadataUxBrief,
          },
        },
        sourceChannel,
      );
      channelDeliveryStore.linkMessage(eventId, userMessageId);
      channelDeliveryStore.markProcessed(eventId);

      if (replyCallbackUrl) {
        await deliverReplyViaCallback(conversationId, externalChatId, replyCallbackUrl, bearerToken);
      }
    } catch (err) {
      log.error({ err, conversationId }, 'Background channel message processing failed');
      channelDeliveryStore.recordProcessingFailure(eventId, err);
    }
  })();
}

// ---------------------------------------------------------------------------
// Orchestrator-backed channel processing with approval prompt delivery
// ---------------------------------------------------------------------------

const RUN_POLL_INTERVAL_MS = 500;
const RUN_POLL_MAX_WAIT_MS = 300_000; // 5 minutes

interface ApprovalProcessingParams {
  orchestrator: RunOrchestrator;
  conversationId: string;
  eventId: string;
  content: string;
  attachmentIds?: string[];
  externalChatId: string;
  sourceChannel: string;
  replyCallbackUrl: string;
  bearerToken?: string;
  guardianCtx: GuardianContext;
}

/**
 * Process a channel message using the run orchestrator so that
 * `confirmation_request` events are intercepted and written to the
 * runs store. Polls the run until it reaches a terminal state,
 * sending approval prompts when `needs_confirmation` is detected.
 *
 * When the actor is a non-guardian:
 * - `forceStrictSideEffects` is set on the run so all side-effect tools
 *   trigger the confirmation flow
 * - Approval prompts are routed to the guardian's chat
 * - A `channelGuardianApprovalRequest` record is created
 */
function processChannelMessageWithApprovals(params: ApprovalProcessingParams): void {
  const {
    orchestrator,
    conversationId,
    eventId,
    content,
    attachmentIds,
    externalChatId,
    sourceChannel,
    replyCallbackUrl,
    bearerToken,
    guardianCtx,
  } = params;

  const isNonGuardian = guardianCtx.actorRole === 'non-guardian';

  (async () => {
    try {
      const run = await orchestrator.startRun(
        conversationId,
        content,
        attachmentIds,
        isNonGuardian ? { forceStrictSideEffects: true } : undefined,
      );

      // Poll the run until it reaches a terminal state, delivering approval
      // prompts when it transitions to needs_confirmation.
      const startTime = Date.now();
      let lastStatus = run.status;

      while (Date.now() - startTime < RUN_POLL_MAX_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL_MS));

        const current = orchestrator.getRun(run.id);
        if (!current) break;

        if (current.status === 'needs_confirmation' && lastStatus !== 'needs_confirmation') {
          const pending = getPendingConfirmationsByConversation(conversationId);

          if (isNonGuardian && guardianCtx.guardianChatId && pending.length > 0) {
            // Non-guardian actor: route the approval prompt to the guardian's chat
            const guardianPrompt = buildGuardianApprovalPrompt(
              pending[0],
              guardianCtx.requesterIdentifier ?? 'Unknown user',
            );
            const uiMetadata = buildApprovalUIMetadata(guardianPrompt, pending[0]);

            // Persist the guardian approval request so we can look it up when
            // the guardian responds from their chat.
            createApprovalRequest({
              runId: run.id,
              conversationId,
              channel: sourceChannel,
              requesterExternalUserId: guardianCtx.requesterExternalUserId ?? '',
              requesterChatId: guardianCtx.requesterChatId ?? externalChatId,
              guardianExternalUserId: guardianCtx.guardianExternalUserId ?? '',
              guardianChatId: guardianCtx.guardianChatId,
              toolName: pending[0].toolName,
              riskLevel: pending[0].riskLevel,
              expiresAt: Date.now() + GUARDIAN_APPROVAL_TTL_MS,
            });

            try {
              await deliverApprovalPrompt(
                replyCallbackUrl,
                guardianCtx.guardianChatId,
                guardianPrompt.promptText,
                uiMetadata,
                bearerToken,
              );
            } catch (err) {
              log.error({ err, runId: run.id }, 'Failed to deliver guardian approval prompt');
            }

            // Notify the requester that their request is pending guardian approval
            try {
              await deliverChannelReply(replyCallbackUrl, {
                chatId: guardianCtx.requesterChatId ?? externalChatId,
                text: `Your request to run "${pending[0].toolName}" has been sent to the guardian for approval.`,
              }, bearerToken);
            } catch (err) {
              log.error({ err, runId: run.id }, 'Failed to notify requester of pending guardian approval');
            }
          } else {
            // Guardian actor or no guardian binding: standard approval prompt
            // sent to the requester's own chat.
            const prompt = getChannelApprovalPrompt(conversationId);
            if (prompt && pending.length > 0) {
              const uiMetadata = buildApprovalUIMetadata(prompt, pending[0]);
              try {
                await deliverApprovalPrompt(
                  replyCallbackUrl,
                  externalChatId,
                  prompt.promptText,
                  uiMetadata,
                  bearerToken,
                );
              } catch (err) {
                log.error({ err, runId: run.id }, 'Failed to deliver approval prompt for channel run');
              }
            }
          }
        }

        lastStatus = current.status;

        if (current.status === 'completed' || current.status === 'failed') {
          break;
        }
      }

      // Only mark processed and deliver the final reply when the run has
      // actually reached a terminal state. If the poll loop timed out while
      // the run is still in progress, leave the event unprocessed so it can
      // be retried or dead-lettered.
      const finalRun = orchestrator.getRun(run.id);
      const isTerminal = finalRun?.status === 'completed' || finalRun?.status === 'failed';

      if (isTerminal) {
        // Link the inbound event to the user message created by the run so
        // that edit lookups and dead letter replay work correctly.
        if (run.messageId) {
          channelDeliveryStore.linkMessage(eventId, run.messageId);
        }

        channelDeliveryStore.markProcessed(eventId);

        // Deliver the final assistant reply to the requester's chat
        await deliverReplyViaCallback(conversationId, externalChatId, replyCallbackUrl, bearerToken);

        // If this was a non-guardian run that went through guardian approval,
        // also notify the guardian's chat about the outcome.
        if (isNonGuardian && guardianCtx.guardianChatId) {
          const approvalReq = getPendingApprovalForRun(run.id);
          if (approvalReq) {
            // The approval was resolved (run completed or failed) — mark it
            const outcomeStatus = finalRun?.status === 'completed' ? 'approved' as const : 'denied' as const;
            updateApprovalDecision(approvalReq.id, { status: outcomeStatus });
          }
        }
      } else {
        log.warn(
          { runId: run.id, status: finalRun?.status, conversationId },
          'Approval-path poll loop timed out before run reached terminal state',
        );
      }
    } catch (err) {
      log.error({ err, conversationId }, 'Approval-aware channel message processing failed');
      channelDeliveryStore.recordProcessingFailure(eventId, err);
    }
  })();
}

// ---------------------------------------------------------------------------
// Approval interception
// ---------------------------------------------------------------------------

interface ApprovalInterceptionParams {
  conversationId: string;
  callbackData?: string;
  content: string;
  externalChatId: string;
  sourceChannel: string;
  senderExternalUserId?: string;
  replyCallbackUrl: string;
  bearerToken?: string;
  orchestrator: RunOrchestrator;
  guardianCtx: GuardianContext;
}

interface ApprovalInterceptionResult {
  handled: boolean;
  type?: 'decision_applied' | 'reminder_sent' | 'guardian_decision_applied' | 'stale_ignored';
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
async function handleApprovalInterception(
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
  } = params;

  // ── Guardian approval decision path ──
  // When the sender is the guardian and there's a pending guardian approval
  // request targeting this chat, the message might be a decision on behalf
  // of a non-guardian requester.
  if (
    guardianCtx.actorRole === 'guardian' &&
    senderExternalUserId
  ) {
    const guardianApproval = getPendingApprovalByGuardianChat(sourceChannel, externalChatId);
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
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: 'Only the verified guardian can approve or deny this request.',
          }, bearerToken);
        } catch (err) {
          log.error({ err, externalChatId }, 'Failed to deliver guardian identity rejection notice');
        }
        return { handled: true, type: 'guardian_decision_applied' };
      }

      let decision: ApprovalDecisionResult | null = null;

      if (callbackData) {
        decision = parseCallbackData(callbackData);
      }
      if (!decision && content) {
        decision = parseApprovalDecision(content);
      }

      if (decision) {
        // approve_always is not available for guardian approvals — guardians
        // should not be able to permanently allowlist tools on behalf of the
        // requester. Downgrade to approve_once.
        if (decision.action === 'approve_always') {
          decision = { ...decision, action: 'approve_once' };
        }

        // Validate run ID from callback matches the guardian approval's run
        if (decision.runId && decision.runId !== guardianApproval.runId) {
          log.warn(
            { externalChatId, callbackRunId: decision.runId, approvalRunId: guardianApproval.runId },
            'Callback run ID does not match guardian approval run, ignoring stale button press',
          );
          return { handled: true, type: 'stale_ignored' };
        }

        // Apply the decision to the underlying run using the requester's
        // conversation context
        const result = handleChannelDecision(
          guardianApproval.conversationId,
          decision,
          orchestrator,
        );

        // Update the guardian approval request record
        const approvalStatus = decision.action === 'reject' ? 'denied' as const : 'approved' as const;
        updateApprovalDecision(guardianApproval.id, {
          status: approvalStatus,
          decidedByExternalUserId: senderExternalUserId,
        });

        if (result.applied) {
          // Notify the requester's chat about the outcome with the tool name
          const toolLabel = guardianApproval.toolName;
          const outcomeText = decision.action === 'reject'
            ? `Your request to run "${toolLabel}" was denied by the guardian.`
            : `Your request to run "${toolLabel}" was approved by the guardian.`;
          try {
            await deliverChannelReply(replyCallbackUrl, {
              chatId: guardianApproval.requesterChatId,
              text: outcomeText,
            }, bearerToken);
          } catch (err) {
            log.error({ err, conversationId: guardianApproval.conversationId }, 'Failed to notify requester of guardian decision');
          }
        }

        return { handled: true, type: 'guardian_decision_applied' };
      }

      // Non-decision message from guardian while approval is pending — remind them
      const pendingInfo = getPendingConfirmationsByConversation(guardianApproval.conversationId);
      if (pendingInfo.length > 0) {
        const guardianPrompt = buildGuardianApprovalPrompt(
          pendingInfo[0],
          `user ${guardianApproval.requesterExternalUserId}`,
        );
        const reminder = buildReminderPrompt(guardianPrompt);
        const uiMetadata = buildApprovalUIMetadata(reminder, pendingInfo[0]);
        try {
          await deliverApprovalPrompt(
            replyCallbackUrl,
            externalChatId,
            reminder.promptText,
            uiMetadata,
            bearerToken,
          );
        } catch (err) {
          log.error({ err, conversationId: guardianApproval.conversationId }, 'Failed to deliver guardian approval reminder');
        }
      }

      return { handled: true, type: 'reminder_sent' };
    }
  }

  // ── Standard approval interception (existing flow) ──
  const pendingPrompt = getChannelApprovalPrompt(conversationId);
  if (!pendingPrompt) return { handled: false };

  // When the sender is a non-guardian and there's a pending guardian approval
  // for this conversation's run, block self-approval. The non-guardian must
  // wait for the guardian to decide.
  if (guardianCtx.actorRole === 'non-guardian') {
    const pending = getPendingConfirmationsByConversation(conversationId);
    if (pending.length > 0) {
      const guardianApprovalForRun = getPendingApprovalForRun(pending[0].runId);
      if (guardianApprovalForRun) {
        try {
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: 'Your request is pending guardian approval. Only the verified guardian can approve or deny this request.',
          }, bearerToken);
        } catch (err) {
          log.error({ err, conversationId }, 'Failed to deliver guardian-pending notice to requester');
        }
        return { handled: true, type: 'reminder_sent' };
      }
    }
  }

  // Try to extract a decision from callback data (button press) first,
  // then fall back to plain-text parsing.
  let decision: ApprovalDecisionResult | null = null;

  if (callbackData) {
    decision = parseCallbackData(callbackData);
  }

  if (!decision && content) {
    decision = parseApprovalDecision(content);
  }

  if (decision) {
    // When the decision came from a callback button, validate that the embedded
    // run ID matches the currently pending run. A stale button (from a previous
    // approval prompt) must not apply to a different pending run.
    if (decision.runId) {
      const pending = getPendingConfirmationsByConversation(conversationId);
      if (pending.length === 0 || pending[0].runId !== decision.runId) {
        log.warn(
          { conversationId, callbackRunId: decision.runId, pendingRunId: pending[0]?.runId },
          'Callback run ID does not match pending run, ignoring stale button press',
        );
        return { handled: true, type: 'stale_ignored' };
      }
    }

    const result = handleChannelDecision(conversationId, decision, orchestrator);

    if (result.applied) {
      // Deliver the run's result back to the channel once the decision is applied.
      // The run will resume in the background; deliver whatever assistant reply
      // is available now (there may not be one yet if the run is still processing).
      try {
        await deliverReplyViaCallback(conversationId, externalChatId, replyCallbackUrl, bearerToken);
      } catch (err) {
        log.error({ err, conversationId }, 'Failed to deliver post-decision reply');
      }
    }

    return { handled: true, type: 'decision_applied' };
  }

  // The message is not a decision — send a reminder with the approval buttons.
  const reminder = buildReminderPrompt(pendingPrompt);
  const pending = getPendingConfirmationsByConversation(conversationId);
  if (pending.length > 0) {
    const uiMetadata = buildApprovalUIMetadata(reminder, pending[0]);
    try {
      await deliverApprovalPrompt(
        replyCallbackUrl,
        externalChatId,
        reminder.promptText,
        uiMetadata,
        bearerToken,
      );
    } catch (err) {
      log.error({ err, conversationId }, 'Failed to deliver approval reminder');
    }
  }

  return { handled: true, type: 'reminder_sent' };
}

async function deliverReplyViaCallback(
  conversationId: string,
  externalChatId: string,
  callbackUrl: string,
  bearerToken?: string,
): Promise<void> {
  const msgs = conversationStore.getMessages(conversationId);
  for (let i = msgs.length - 1; i >= 0; i--) {
    if (msgs[i].role === 'assistant') {
      let parsed: unknown;
      try { parsed = JSON.parse(msgs[i].content); } catch { parsed = msgs[i].content; }
      const rendered = renderHistoryContent(parsed);

      const linked = attachmentsStore.getAttachmentMetadataForMessage(msgs[i].id);
      const replyAttachments: RuntimeAttachmentMetadata[] = linked.map((a) => ({
        id: a.id,
        filename: a.originalFilename,
        mimeType: a.mimeType,
        sizeBytes: a.sizeBytes,
        kind: a.kind,
      }));

      if (rendered.text || replyAttachments.length > 0) {
        await deliverChannelReply(callbackUrl, {
          chatId: externalChatId,
          text: rendered.text || undefined,
          attachments: replyAttachments.length > 0 ? replyAttachments : undefined,
        }, bearerToken);
      }
      break;
    }
  }
}

export function handleListDeadLetters(): Response {
  const events = channelDeliveryStore.getDeadLetterEvents();
  return Response.json({ events });
}

export async function handleReplayDeadLetters(req: Request): Promise<Response> {
  const body = await req.json() as { eventIds?: string[] };
  const eventIds = body.eventIds;

  if (!Array.isArray(eventIds) || eventIds.length === 0) {
    return Response.json({ error: 'eventIds array is required' }, { status: 400 });
  }

  const replayed = channelDeliveryStore.replayDeadLetters(eventIds);
  return Response.json({ replayed });
}

export async function handleChannelDeliveryAck(req: Request): Promise<Response> {
  const body = await req.json() as {
    sourceChannel?: string;
    externalChatId?: string;
    externalMessageId?: string;
  };

  const { sourceChannel, externalChatId, externalMessageId } = body;

  if (!sourceChannel || typeof sourceChannel !== 'string') {
    return Response.json({ error: 'sourceChannel is required' }, { status: 400 });
  }
  if (!externalChatId || typeof externalChatId !== 'string') {
    return Response.json({ error: 'externalChatId is required' }, { status: 400 });
  }
  if (!externalMessageId || typeof externalMessageId !== 'string') {
    return Response.json({ error: 'externalMessageId is required' }, { status: 400 });
  }

  const acked = channelDeliveryStore.acknowledgeDelivery(
    sourceChannel,
    externalChatId,
    externalMessageId,
  );

  if (!acked) {
    return Response.json({ error: 'Inbound event not found' }, { status: 404 });
  }

  return new Response(null, { status: 204 });
}
