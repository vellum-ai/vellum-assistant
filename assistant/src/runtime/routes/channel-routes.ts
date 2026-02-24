/**
 * Route handlers for channel inbound messages, delivery acks, and
 * conversation deletion.
 */
import { timingSafeEqual } from 'node:crypto';
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
  getPendingApprovalByRunAndGuardianChat,
  getAllPendingApprovalsByGuardianChat,
  getPendingApprovalForRun,
  getUnresolvedApprovalForRun,
  getExpiredPendingApprovals,
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
  channelSupportsRichApprovalUI,
} from '../channel-approvals.js';
import type { ApprovalAction, ApprovalDecisionResult } from '../channel-approval-types.js';
import type { RunOrchestrator } from '../run-orchestrator.js';
import type {
  MessageProcessor,
  RuntimeAttachmentMetadata,
} from '../http-types.js';
import type { GuardianRuntimeContext } from '../../daemon/session-runtime-assembly.js';
import { composeApprovalMessage } from '../approval-message-composer.js';

const log = getLogger('runtime-http');

// ---------------------------------------------------------------------------
// Gateway-origin proof
// ---------------------------------------------------------------------------

/**
 * Header name used by the gateway to prove a request originated from it.
 * The gateway sends a dedicated gateway-origin secret (or the bearer token
 * as fallback). The runtime validates it using constant-time comparison.
 * Requests to `/channels/inbound` that lack a valid proof are rejected with 403.
 */
export const GATEWAY_ORIGIN_HEADER = 'X-Gateway-Origin';

/**
 * Validate that the request carries a valid gateway-origin proof.
 * Uses constant-time comparison to prevent timing attacks.
 *
 * The `gatewayOriginSecret` parameter is the dedicated secret configured
 * via `RUNTIME_GATEWAY_ORIGIN_SECRET`. When set, only this value is
 * accepted. When not set, the function falls back to `bearerToken` for
 * backward compatibility. When neither is configured (local dev), validation
 * is skipped entirely.
 */
export function verifyGatewayOrigin(
  req: Request,
  bearerToken?: string,
  gatewayOriginSecret?: string,
): boolean {
  // Determine the expected secret: prefer dedicated secret, fall back to bearer token
  const expectedSecret = gatewayOriginSecret ?? bearerToken;
  if (!expectedSecret) return true; // No shared secret configured — skip validation
  const provided = req.headers.get(GATEWAY_ORIGIN_HEADER);
  if (!provided) return false;
  const a = Buffer.from(provided);
  const b = Buffer.from(expectedSecret);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

// ---------------------------------------------------------------------------
// Actor role
// ---------------------------------------------------------------------------

export type ActorRole = 'guardian' | 'non-guardian' | 'unverified_channel';

/** Sub-reason for `unverified_channel` denials. */
export type DenialReason = 'no_binding' | 'no_identity';

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
  /** Sub-reason when actorRole is 'unverified_channel'. */
  denialReason?: DenialReason;
}

function toGuardianRuntimeContext(sourceChannel: string, ctx: GuardianContext): GuardianRuntimeContext {
  return {
    sourceChannel,
    actorRole: ctx.actorRole,
    guardianChatId: ctx.guardianChatId,
    guardianExternalUserId: ctx.guardianExternalUserId,
    requesterIdentifier: ctx.requesterIdentifier,
    requesterExternalUserId: ctx.requesterExternalUserId,
    requesterChatId: ctx.requesterChatId,
    denialReason: ctx.denialReason,
  };
}

/** Guardian approval request expiry (30 minutes). */
const GUARDIAN_APPROVAL_TTL_MS = 30 * 60 * 1000;

/**
 * Return the effective prompt text for an approval prompt, appending the
 * plainTextFallback instructions when the channel does not support rich
 * inline approval UI (e.g. Telegram inline keyboards).
 */
function effectivePromptText(
  promptText: string,
  plainTextFallback: string,
  channel: string,
): string {
  if (channelSupportsRichApprovalUI(channel)) return promptText;
  return plainTextFallback;
}

/**
 * Build contextual deny guidance for guardian-gated auto-deny paths.
 * This is passed through the confirmation pipeline so the assistant can
 * produce a single, user-facing message with next steps.
 */
function buildGuardianDenyContext(
  toolName: string,
  denialReason: DenialReason,
  sourceChannel: string,
): string {
  if (denialReason === 'no_identity') {
    return `Permission denied: ${composeApprovalMessage({ scenario: 'guardian_deny_no_identity', toolName, channel: sourceChannel })} Do not retry yet. Ask the user to message from a verifiable direct account/chat, and then retry after identity is available.`;
  }

  return `Permission denied: ${composeApprovalMessage({ scenario: 'guardian_deny_no_binding', toolName, channel: sourceChannel })} Do not retry yet. Offer to set up guardian verification. The setup flow will provide a verification token to send as /guardian_verify <token>.`;
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

export async function handleDeleteConversation(req: Request, assistantId: string = 'self'): Promise<Response> {
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

  // Delete the assistant-scoped key unconditionally. The legacy key is
  // canonical for the self assistant and must not be deleted from non-self
  // routes, otherwise a non-self reset can accidentally reset self state.
  const legacyKey = `${sourceChannel}:${externalChatId}`;
  const scopedKey = `asst:${assistantId}:${sourceChannel}:${externalChatId}`;
  deleteConversationKey(scopedKey);
  if (assistantId === 'self') {
    deleteConversationKey(legacyKey);
  }
  // external_conversation_bindings is currently assistant-agnostic
  // (unique by sourceChannel + externalChatId). Restrict mutations to the
  // canonical self-assistant route so multi-assistant legacy routes do not
  // clobber each other's bindings.
  if (assistantId === 'self') {
    externalConversationStore.deleteBindingByChannelChat(sourceChannel, externalChatId);
  }

  return Response.json({ ok: true });
}

export async function handleChannelInbound(
  req: Request,
  processMessage?: MessageProcessor,
  bearerToken?: string,
  runOrchestrator?: RunOrchestrator,
  assistantId: string = 'self',
  gatewayOriginSecret?: string,
): Promise<Response> {
  // Reject requests that lack valid gateway-origin proof. This ensures
  // channel inbound messages can only arrive via the gateway (which
  // performs webhook-level verification) and not via direct HTTP calls.
  if (!verifyGatewayOrigin(req, bearerToken, gatewayOriginSecret)) {
    log.warn('Rejected channel inbound request: missing or invalid gateway-origin proof');
    return Response.json(
      { error: 'Forbidden: missing gateway-origin proof', code: 'GATEWAY_ORIGIN_REQUIRED' },
      { status: 403 },
    );
  }

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
      { sourceMessageId, assistantId },
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
          { assistantId, sourceMessageId, attempt: attempt + 1, maxAttempts: EDIT_LOOKUP_RETRIES },
          'Original message not linked yet, retrying edit lookup',
        );
        await new Promise((resolve) => setTimeout(resolve, EDIT_LOOKUP_DELAY_MS));
      }
    }

    if (original) {
      conversationStore.updateMessageContent(original.messageId, content ?? '');
      log.info(
        { assistantId, sourceMessageId, messageId: original.messageId },
        'Updated message content from edited_message',
      );
    } else {
      log.warn(
        { assistantId, sourceChannel, externalChatId, sourceMessageId },
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
    { sourceMessageId, assistantId },
  );

  // external_conversation_bindings is assistant-agnostic. Restrict writes to
  // self so assistant-scoped legacy routes do not overwrite each other's
  // channel binding metadata for the same chat.
  if (assistantId === 'self') {
    externalConversationStore.upsertBinding({
      conversationId: result.conversationId,
      sourceChannel,
      externalChatId,
      externalUserId: body.senderExternalUserId ?? null,
      displayName: body.senderName ?? null,
      username: body.senderUsername ?? null,
    });
  }

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
        assistantId,
        sourceChannel,
        token,
        body.senderExternalUserId,
        externalChatId,
        body.senderUsername,
        body.senderName,
      );

      const replyText = verifyResult.success
        ? 'Guardian verified successfully. Your identity is now linked to this bot.'
        : 'Verification failed. Please try again later.';

      try {
        await deliverChannelReply(replyCallbackUrl, {
          chatId: externalChatId,
          text: replyText,
          assistantId,
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
  //
  // Guardian actor-role resolution always runs.
  let guardianCtx: GuardianContext;
  if (body.senderExternalUserId) {
    const requesterLabel = body.senderUsername
      ? `@${body.senderUsername}`
      : body.senderExternalUserId;
    const senderIsGuardian = isGuardian(assistantId, sourceChannel, body.senderExternalUserId);
    if (senderIsGuardian) {
      const binding = getGuardianBinding(assistantId, sourceChannel);
      guardianCtx = {
        actorRole: 'guardian',
        guardianChatId: binding?.guardianDeliveryChatId ?? externalChatId,
        guardianExternalUserId: binding?.guardianExternalUserId ?? body.senderExternalUserId,
        requesterIdentifier: requesterLabel,
        requesterExternalUserId: body.senderExternalUserId,
        requesterChatId: externalChatId,
      };
    } else {
      const binding = getGuardianBinding(assistantId, sourceChannel);
      if (binding) {
        guardianCtx = {
          actorRole: 'non-guardian',
          guardianChatId: binding.guardianDeliveryChatId,
          guardianExternalUserId: binding.guardianExternalUserId,
          requesterIdentifier: requesterLabel,
          requesterExternalUserId: body.senderExternalUserId,
          requesterChatId: externalChatId,
        };
      } else {
        // No guardian binding configured for this channel — the sender is
        // unverified. Sensitive actions will be auto-denied (fail-closed).
        guardianCtx = {
          actorRole: 'unverified_channel',
          denialReason: 'no_binding',
          requesterIdentifier: requesterLabel,
          requesterExternalUserId: body.senderExternalUserId,
          requesterChatId: externalChatId,
        };
      }
    }
  } else {
    // No sender identity available — treat as unverified and fail closed.
    // Multi-actor channels must not grant default guardian permissions when
    // the inbound actor cannot be identified.
    guardianCtx = {
      actorRole: 'unverified_channel',
      denialReason: 'no_identity',
      requesterIdentifier: body.senderUsername ? `@${body.senderUsername}` : undefined,
      requesterExternalUserId: undefined,
      requesterChatId: externalChatId,
    };
  }

  // ── Approval interception ──
  // Keep this active whenever orchestrator + callback context are available.
  if (
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
      assistantId,
    });

    if (approvalResult.handled) {
      return Response.json({
        accepted: true,
        duplicate: false,
        eventId: result.eventId,
        approval: approvalResult.type,
      });
    }

    // When a callback payload was not handled by approval interception, it's
    // a stale button press with no pending approval. Return early regardless
    // of whether content/attachments are present — callback payloads always
    // have non-empty content (normalize.ts sets message.content to cbq.data),
    // so checking for empty content alone would miss stale callbacks.
    if (hasCallbackData) {
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
      guardianCtx,
      replyCallbackUrl,
      assistantId,
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

    // Use the approval-aware orchestrator path whenever orchestration and a
    // callback delivery target are available. This keeps approval handling
    // consistent across all channels and avoids silent prompt timeouts.
    const useApprovalPath = Boolean(
      runOrchestrator &&
      replyCallbackUrl,
    );

    if (useApprovalPath && runOrchestrator && replyCallbackUrl) {
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
        assistantId,
        metadataHints,
        metadataUxBrief,
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
        guardianCtx,
        metadataHints,
        metadataUxBrief,
        replyCallbackUrl,
        bearerToken,
        assistantId,
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
  guardianCtx: GuardianContext;
  metadataHints: string[];
  metadataUxBrief?: string;
  replyCallbackUrl?: string;
  bearerToken?: string;
  assistantId?: string;
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
    guardianCtx,
    metadataHints,
    metadataUxBrief,
    replyCallbackUrl,
    bearerToken,
    assistantId,
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
          assistantId,
          guardianContext: toGuardianRuntimeContext(sourceChannel, guardianCtx),
        },
        sourceChannel,
      );
      channelDeliveryStore.linkMessage(eventId, userMessageId);
      channelDeliveryStore.markProcessed(eventId);

      if (replyCallbackUrl) {
        await deliverReplyViaCallback(
          conversationId,
          externalChatId,
          replyCallbackUrl,
          bearerToken,
          assistantId,
        );
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

/** Post-decision delivery poll: uses the same budget as the main poll since
 *  this is the only delivery path for late approvals after the main poll exits. */
const POST_DECISION_POLL_INTERVAL_MS = 500;
const POST_DECISION_POLL_MAX_WAIT_MS = RUN_POLL_MAX_WAIT_MS;

/**
 * Override the poll max-wait for tests. When set, used in place of
 * RUN_POLL_MAX_WAIT_MS so tests can exercise timeout paths without
 * waiting 5 minutes.
 */
let testPollMaxWaitOverride: number | null = null;

/** @internal — test-only: set an override for the poll max-wait. */
export function _setTestPollMaxWait(ms: number | null): void {
  testPollMaxWaitOverride = ms;
}

function getEffectivePollMaxWait(): number {
  return testPollMaxWaitOverride ?? RUN_POLL_MAX_WAIT_MS;
}

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
  assistantId: string;
  metadataHints: string[];
  metadataUxBrief?: string;
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
    assistantId,
    metadataHints,
    metadataUxBrief,
  } = params;

  const isNonGuardian = guardianCtx.actorRole === 'non-guardian';
  const isUnverifiedChannel = guardianCtx.actorRole === 'unverified_channel';

  (async () => {
    try {
      const run = await orchestrator.startRun(
        conversationId,
        content,
        attachmentIds,
        {
          ...((isNonGuardian || isUnverifiedChannel) ? { forceStrictSideEffects: true } : {}),
          sourceChannel,
          hints: metadataHints.length > 0 ? metadataHints : undefined,
          uxBrief: metadataUxBrief,
          assistantId,
          guardianContext: toGuardianRuntimeContext(sourceChannel, guardianCtx),
        },
      );

      // Poll the run until it reaches a terminal state, delivering approval
      // prompts when it transitions to needs_confirmation.
      const startTime = Date.now();
      const pollMaxWait = getEffectivePollMaxWait();
      let lastStatus = run.status;
      // Track whether a post-decision delivery path is guaranteed for this
      // run. Set to true only when the approval prompt is successfully
      // delivered (guardian or standard path), meaning
      // handleApprovalInterception will schedule schedulePostDecisionDelivery
      // when a decision arrives. Auto-deny paths (unverified channel, prompt
      // delivery failures) do NOT set this flag because no post-decision
      // delivery is scheduled in those cases.
      let hasPostDecisionDelivery = false;

      while (Date.now() - startTime < pollMaxWait) {
        await new Promise((resolve) => setTimeout(resolve, RUN_POLL_INTERVAL_MS));

        const current = orchestrator.getRun(run.id);
        if (!current) break;

        if (current.status === 'needs_confirmation' && lastStatus !== 'needs_confirmation') {
          const pending = getPendingConfirmationsByConversation(conversationId);

          if (isUnverifiedChannel && pending.length > 0) {
            // Unverified channel — auto-deny the sensitive action (fail-closed).
            handleChannelDecision(
              conversationId,
              { action: 'reject', source: 'plain_text' },
              orchestrator,
              buildGuardianDenyContext(
                pending[0].toolName,
                guardianCtx.denialReason ?? 'no_binding',
                sourceChannel,
              ),
            );
          } else if (isNonGuardian && guardianCtx.guardianChatId && pending.length > 0) {
            // Non-guardian actor: route the approval prompt to the guardian's chat
            const guardianPrompt = buildGuardianApprovalPrompt(
              pending[0],
              guardianCtx.requesterIdentifier ?? 'Unknown user',
            );
            const uiMetadata = buildApprovalUIMetadata(guardianPrompt, pending[0]);

            // Persist the guardian approval request so we can look it up when
            // the guardian responds from their chat.
            const approvalReqRecord = createApprovalRequest({
              runId: run.id,
              conversationId,
              assistantId,
              channel: sourceChannel,
              requesterExternalUserId: guardianCtx.requesterExternalUserId ?? '',
              requesterChatId: guardianCtx.requesterChatId ?? externalChatId,
              guardianExternalUserId: guardianCtx.guardianExternalUserId ?? '',
              guardianChatId: guardianCtx.guardianChatId,
              toolName: pending[0].toolName,
              riskLevel: pending[0].riskLevel,
              expiresAt: Date.now() + GUARDIAN_APPROVAL_TTL_MS,
            });

            let guardianNotified = false;
            try {
              const guardianText = effectivePromptText(
                guardianPrompt.promptText,
                guardianPrompt.plainTextFallback,
                sourceChannel,
              );
              await deliverApprovalPrompt(
                replyCallbackUrl,
                guardianCtx.guardianChatId,
                guardianText,
                uiMetadata,
                assistantId,
                bearerToken,
              );
              guardianNotified = true;
              hasPostDecisionDelivery = true;
            } catch (err) {
              log.error({ err, runId: run.id }, 'Failed to deliver guardian approval prompt');
              // Deny the approval and the underlying run — fail-closed. If
              // the prompt could not be delivered, the guardian will never see
              // it, so the safest action is to deny rather than cancel (which
              // would allow requester fallback).
              updateApprovalDecision(approvalReqRecord.id, { status: 'denied' });
              handleChannelDecision(conversationId, { action: 'reject', source: 'plain_text' }, orchestrator);
              try {
                await deliverChannelReply(replyCallbackUrl, {
                  chatId: guardianCtx.requesterChatId ?? externalChatId,
                  text: composeApprovalMessage({ scenario: 'guardian_delivery_failed', toolName: pending[0].toolName }),
                  assistantId,
                }, bearerToken);
              } catch (notifyErr) {
                log.error({ err: notifyErr, runId: run.id }, 'Failed to notify requester of guardian delivery failure');
              }
            }

            // Only notify the requester if the guardian prompt was actually delivered
            if (guardianNotified) {
              try {
                await deliverChannelReply(replyCallbackUrl, {
                  chatId: guardianCtx.requesterChatId ?? externalChatId,
                  text: composeApprovalMessage({ scenario: 'guardian_request_forwarded', toolName: pending[0].toolName }),
                  assistantId,
                }, bearerToken);
              } catch (err) {
                log.error({ err, runId: run.id }, 'Failed to notify requester of pending guardian approval');
              }
            }
          } else {
            // Guardian actor or no guardian binding: standard approval prompt
            // sent to the requester's own chat.
            const prompt = getChannelApprovalPrompt(conversationId);
            if (prompt && pending.length > 0) {
              const uiMetadata = buildApprovalUIMetadata(prompt, pending[0]);
              try {
                const promptTextForChannel = effectivePromptText(
                  prompt.promptText,
                  prompt.plainTextFallback,
                  sourceChannel,
                );
                await deliverApprovalPrompt(
                  replyCallbackUrl,
                  externalChatId,
                  promptTextForChannel,
                  uiMetadata,
                  assistantId,
                  bearerToken,
                );
                hasPostDecisionDelivery = true;
              } catch (err) {
                // Fail-closed: if we cannot deliver the approval prompt, the
                // user will never see it and the run would hang indefinitely
                // in needs_confirmation. Auto-deny to avoid silent wait states.
                log.error(
                  { err, runId: run.id, conversationId },
                  'Failed to deliver standard approval prompt; auto-denying (fail-closed)',
                );
                handleChannelDecision(conversationId, { action: 'reject', source: 'plain_text' }, orchestrator);
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
      // actually reached a terminal state.
      const finalRun = orchestrator.getRun(run.id);
      const isTerminal = finalRun?.status === 'completed' || finalRun?.status === 'failed';

      if (isTerminal) {
        // Link the inbound event to the user message created by the run so
        // that edit lookups and dead letter replay work correctly.
        if (run.messageId) {
          channelDeliveryStore.linkMessage(eventId, run.messageId);
        }

        channelDeliveryStore.markProcessed(eventId);

        // Deliver the final assistant reply exactly once. The post-decision
        // poll in schedulePostDecisionDelivery races with this path; the
        // claimRunDelivery guard ensures only the winner sends the reply.
        // If delivery fails, release the claim so the other poller can retry
        // rather than permanently losing the reply.
        if (channelDeliveryStore.claimRunDelivery(run.id)) {
          try {
            await deliverReplyViaCallback(
              conversationId,
              externalChatId,
              replyCallbackUrl,
              bearerToken,
              assistantId,
            );
          } catch (deliveryErr) {
            channelDeliveryStore.resetRunDeliveryClaim(run.id);
            throw deliveryErr;
          }
        }

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
      } else if (
        finalRun?.status === 'needs_confirmation' ||
        (hasPostDecisionDelivery && finalRun?.status === 'running')
      ) {
        // The run is either still waiting for an approval decision or was
        // recently approved and has resumed execution. In both cases, mark
        // the event as processed rather than failed:
        //
        // - needs_confirmation: the run will resume when the user clicks
        //   approve/reject, and `handleApprovalInterception` will deliver
        //   the reply via `schedulePostDecisionDelivery`.
        //
        // - running (after successful prompt delivery): an approval was
        //   applied near the poll deadline and the run resumed but hasn't
        //   reached terminal state yet. `handleApprovalInterception` has
        //   already scheduled post-decision delivery, so the final reply
        //   will be delivered. This condition is only true when the approval
        //   prompt was actually delivered (not in auto-deny paths), ensuring
        //   we don't suppress retry/dead-letter for cases where no
        //   post-decision delivery path exists.
        //
        // Marking either state as failed would cause the generic retry sweep
        // to replay through `processMessage`, which throws "Session is
        // already processing a message" and dead-letters a valid conversation.
        log.warn(
          { runId: run.id, status: finalRun.status, conversationId, hasPostDecisionDelivery },
          'Approval-path poll loop timed out while run is in approval-related state; marking event as processed',
        );
        channelDeliveryStore.markProcessed(eventId);
      } else {
        // The run is in a non-terminal, non-approval state (e.g. running
        // without prior approval, needs_secret, or disappeared). Record a
        // processing failure so the retry/dead-letter machinery can handle it.
        const timeoutErr = new Error(
          `Approval poll timeout: run did not reach terminal state within ${pollMaxWait}ms (status: ${finalRun?.status ?? 'null'})`,
        );
        log.warn(
          { runId: run.id, status: finalRun?.status, conversationId },
          'Approval-path poll loop timed out before run reached terminal state',
        );
        channelDeliveryStore.recordProcessingFailure(eventId, timeoutErr);
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
  assistantId: string;
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
    assistantId,
  } = params;

  // ── Guardian approval decision path ──
  // When the sender is the guardian and there's a pending guardian approval
  // request targeting this chat, the message might be a decision on behalf
  // of a non-guardian requester.
  if (
    guardianCtx.actorRole === 'guardian' &&
    senderExternalUserId
  ) {
    // First, try to parse the inbound payload to determine if it carries
    // a run ID (callback button) or is plain text. This governs how we
    // look up the target approval request.
    let decision: ApprovalDecisionResult | null = null;
    if (callbackData) {
      decision = parseCallbackData(callbackData);
    }
    if (!decision && content) {
      decision = parseApprovalDecision(content);
    }

    // When a callback button provides a run ID, use the scoped lookup so
    // the decision resolves to exactly the right approval even when
    // multiple approvals target the same guardian chat.
    let guardianApproval = decision?.runId
      ? getPendingApprovalByRunAndGuardianChat(decision.runId, sourceChannel, externalChatId, assistantId)
      : null;

    // For plain-text decisions (no run ID), check how many pending
    // approvals exist for this guardian chat. If there are multiple,
    // the guardian must use buttons to disambiguate.
    if (!guardianApproval && decision && !decision.runId) {
      const allPending = getAllPendingApprovalsByGuardianChat(sourceChannel, externalChatId, assistantId);
      if (allPending.length > 1) {
        try {
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: composeApprovalMessage({ scenario: 'guardian_disambiguation', pendingCount: allPending.length }),
            assistantId,
          }, bearerToken);
        } catch (err) {
          log.error({ err, externalChatId }, 'Failed to deliver disambiguation notice');
        }
        return { handled: true, type: 'guardian_decision_applied' };
      }
      if (allPending.length === 1) {
        guardianApproval = allPending[0];
      }
    }

    // Fall back to the single-result lookup for non-decision messages
    // (reminder path) or when the scoped lookup found nothing.
    if (!guardianApproval && !decision) {
      guardianApproval = getPendingApprovalByGuardianChat(sourceChannel, externalChatId, assistantId);
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
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: composeApprovalMessage({ scenario: 'guardian_identity_mismatch' }),
            assistantId,
          }, bearerToken);
        } catch (err) {
          log.error({ err, externalChatId }, 'Failed to deliver guardian identity rejection notice');
        }
        return { handled: true, type: 'guardian_decision_applied' };
      }

      if (decision) {
        // approve_always is not available for guardian approvals — guardians
        // should not be able to permanently allowlist tools on behalf of the
        // requester. Downgrade to approve_once.
        if (decision.action === 'approve_always') {
          decision = { ...decision, action: 'approve_once' };
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
          const outcomeText = composeApprovalMessage({
            scenario: 'guardian_decision_outcome',
            decision: decision.action === 'reject' ? 'denied' : 'approved',
            toolName: guardianApproval.toolName,
          });
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
          const reminderText = effectivePromptText(
            reminder.promptText,
            reminder.plainTextFallback,
            sourceChannel,
          );
          await deliverApprovalPrompt(
            replyCallbackUrl,
            externalChatId,
            reminderText,
            uiMetadata,
            assistantId,
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
        try {
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: composeApprovalMessage({ scenario: 'request_pending_guardian' }),
            assistantId,
          }, bearerToken);
        } catch (err) {
          log.error({ err, conversationId }, 'Failed to deliver guardian-pending notice to requester');
        }
        return { handled: true, type: 'reminder_sent' };
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
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: composeApprovalMessage({ scenario: 'guardian_expired_requester', toolName: pending[0].toolName }),
            assistantId,
          }, bearerToken);
        } catch (err) {
          log.error({ err, conversationId }, 'Failed to deliver guardian-expiry notice to requester');
        }
        return { handled: true, type: 'decision_applied' };
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

    // Schedule a background poll for run terminal state and deliver the reply.
    // This handles the case where the original poll in
    // processChannelMessageWithApprovals has already exited due to timeout.
    // The claimRunDelivery guard ensures at-most-once delivery when both
    // pollers race to terminal state.
    if (result.applied && result.runId) {
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

  // The message is not a decision — send a reminder with the approval buttons.
  const reminder = buildReminderPrompt(pendingPrompt);
  const pending = getPendingConfirmationsByConversation(conversationId);
  if (pending.length > 0) {
    const uiMetadata = buildApprovalUIMetadata(reminder, pending[0]);
    try {
      const reminderText = effectivePromptText(
        reminder.promptText,
        reminder.plainTextFallback,
        sourceChannel,
      );
      await deliverApprovalPrompt(
        replyCallbackUrl,
        externalChatId,
        reminderText,
        uiMetadata,
        assistantId,
        bearerToken,
      );
    } catch (err) {
      log.error({ err, conversationId }, 'Failed to deliver approval reminder');
    }
  }

  return { handled: true, type: 'reminder_sent' };
}

/**
 * Fire-and-forget: after a decision is applied via `handleApprovalInterception`,
 * poll the run briefly for terminal state and deliver the final reply. This
 * handles the case where the original poll in `processChannelMessageWithApprovals`
 * has already exited due to the 5-minute timeout.
 *
 * Uses the same `claimRunDelivery` guard as the main poll to guarantee
 * at-most-once delivery: whichever poller reaches terminal state first
 * claims the delivery, and the other silently skips it.
 */
function schedulePostDecisionDelivery(
  orchestrator: RunOrchestrator,
  runId: string,
  conversationId: string,
  externalChatId: string,
  replyCallbackUrl: string,
  bearerToken?: string,
  assistantId?: string,
): void {
  (async () => {
    try {
      const startTime = Date.now();
      while (Date.now() - startTime < POST_DECISION_POLL_MAX_WAIT_MS) {
        await new Promise((resolve) => setTimeout(resolve, POST_DECISION_POLL_INTERVAL_MS));
        const current = orchestrator.getRun(runId);
        if (!current) break;
        if (current.status === 'completed' || current.status === 'failed') {
          if (channelDeliveryStore.claimRunDelivery(runId)) {
            try {
              await deliverReplyViaCallback(
                conversationId,
                externalChatId,
                replyCallbackUrl,
                bearerToken,
                assistantId,
              );
            } catch (deliveryErr) {
              channelDeliveryStore.resetRunDeliveryClaim(runId);
              throw deliveryErr;
            }
          }
          return;
        }
      }
      log.warn(
        { runId, conversationId },
        'Post-decision delivery poll timed out without run reaching terminal state',
      );
    } catch (err) {
      log.error({ err, runId, conversationId }, 'Post-decision delivery failed');
    }
  })();
}

async function deliverReplyViaCallback(
  conversationId: string,
  externalChatId: string,
  callbackUrl: string,
  bearerToken?: string,
  assistantId?: string,
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
          assistantId,
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

// ---------------------------------------------------------------------------
// Proactive guardian approval expiry sweep
// ---------------------------------------------------------------------------

/** Interval at which the expiry sweep runs (60 seconds). */
const GUARDIAN_EXPIRY_SWEEP_INTERVAL_MS = 60_000;

/** Timer handle for the expiry sweep so it can be stopped in tests. */
let expirySweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Sweep expired guardian approval requests, auto-deny the underlying runs,
 * and notify both the requester and guardian. This runs proactively on a
 * timer so expired approvals are closed without waiting for follow-up
 * traffic from either party.
 *
 * Accepts a `gatewayBaseUrl` rather than a fixed delivery URL so that
 * each approval's notification is routed to the correct channel-specific
 * endpoint (e.g. `/deliver/telegram`, `/deliver/sms`).
 */
export function sweepExpiredGuardianApprovals(
  orchestrator: RunOrchestrator,
  gatewayBaseUrl: string,
  bearerToken?: string,
): void {
  const expired = getExpiredPendingApprovals();
  for (const approval of expired) {
    // Mark the approval as expired
    updateApprovalDecision(approval.id, { status: 'expired' });

    // Auto-deny the underlying run
    const expiredDecision: ApprovalDecisionResult = {
      action: 'reject',
      source: 'plain_text',
    };
    handleChannelDecision(approval.conversationId, expiredDecision, orchestrator);

    // Construct the per-channel delivery URL from the approval's channel
    const deliverUrl = `${gatewayBaseUrl}/deliver/${approval.channel}`;

    // Notify the requester that the approval expired
    deliverChannelReply(deliverUrl, {
      chatId: approval.requesterChatId,
      text: composeApprovalMessage({ scenario: 'guardian_expired_requester', toolName: approval.toolName }),
      assistantId: approval.assistantId,
    }, bearerToken).catch((err) => {
      log.error({ err, runId: approval.runId }, 'Failed to notify requester of guardian approval expiry');
    });

    // Notify the guardian that the approval expired
    deliverChannelReply(deliverUrl, {
      chatId: approval.guardianChatId,
      text: composeApprovalMessage({ scenario: 'guardian_expired_guardian', toolName: approval.toolName, requesterIdentifier: approval.requesterExternalUserId }),
      assistantId: approval.assistantId,
    }, bearerToken).catch((err) => {
      log.error({ err, runId: approval.runId }, 'Failed to notify guardian of approval expiry');
    });

    log.info(
      { runId: approval.runId, approvalId: approval.id },
      'Auto-denied expired guardian approval request',
    );
  }
}

/**
 * Start the periodic expiry sweep. Idempotent — calling it multiple times
 * re-uses the same timer.
 */
export function startGuardianExpirySweep(
  orchestrator: RunOrchestrator,
  gatewayBaseUrl: string,
  bearerToken?: string,
): void {
  if (expirySweepTimer) return;
  expirySweepTimer = setInterval(() => {
    try {
      sweepExpiredGuardianApprovals(orchestrator, gatewayBaseUrl, bearerToken);
    } catch (err) {
      log.error({ err }, 'Guardian expiry sweep failed');
    }
  }, GUARDIAN_EXPIRY_SWEEP_INTERVAL_MS);
}

/**
 * Stop the periodic expiry sweep. Used in tests and shutdown.
 */
export function stopGuardianExpirySweep(): void {
  if (expirySweepTimer) {
    clearInterval(expirySweepTimer);
    expirySweepTimer = null;
  }
}
