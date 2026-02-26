/**
 * Channel inbound message handler: validates, records, and routes inbound
 * messages from all channels. Handles ingress ACL, edits, guardian
 * verification, guardian action answers, and approval interception.
 */
import { answerCall } from '../../calls/call-domain.js';
import type { ChannelId, InterfaceId } from '../../channels/types.js';
import { CHANNEL_IDS, INTERFACE_IDS, isChannelId, parseInterfaceId } from '../../channels/types.js';
import * as attachmentsStore from '../../memory/attachments-store.js';
import * as channelDeliveryStore from '../../memory/channel-delivery-store.js';
import {
  createApprovalRequest,
  updateApprovalDecision,
} from '../../memory/channel-guardian-store.js';
import * as conversationStore from '../../memory/conversation-store.js';
import * as externalConversationStore from '../../memory/external-conversation-store.js';
import {
  getGuardianActionRequest,
  getPendingDeliveriesByDestination,
  resolveGuardianActionRequest,
} from '../../memory/guardian-action-store.js';
import { findMember, updateLastSeen, upsertMember } from '../../memory/ingress-member-store.js';
import { emitNotificationSignal } from '../../notifications/emit-signal.js';
import {
  findLatestUnseenTelegramDelivery,
  recordNotificationDeliveryInteraction,
} from '../../notifications/interactions-store.js';
import { checkIngressForSecrets } from '../../security/secret-ingress.js';
import { getGatewayInternalBaseUrl } from '../../config/env.js';
import { IngressBlockedError } from '../../util/errors.js';
import { getLogger } from '../../util/logger.js';
import { readHttpToken } from '../../util/platform.js';
import { composeApprovalMessageGenerative } from '../approval-message-composer.js';
import {
  createOutboundSession,
  findActiveSession,
  getGuardianBinding,
  getPendingChallenge,
  validateAndConsumeChallenge,
  resolveBootstrapToken,
  bindSessionIdentity,
  updateSessionStatus,
  updateSessionDelivery,
} from '../channel-guardian-service.js';
import { RESEND_COOLDOWN_MS } from '../../daemon/handlers/config-channels.js';
import { deliverChannelReply } from '../gateway-client.js';
import {
  composeChannelVerifyReply,
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from '../guardian-verification-templates.js';
import { resolveGuardianContext } from '../guardian-context-resolver.js';
import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  MessageProcessor,
} from '../http-types.js';
import { deliverReplyViaCallback } from './channel-delivery-routes.js';
import {
  canonicalChannelAssistantId,
  getEffectivePollMaxWait,
  GUARDIAN_APPROVAL_TTL_MS,
  type GuardianContext,
  RUN_POLL_INTERVAL_MS,
  stripVerificationFailurePrefix,
  toGuardianRuntimeContext,
  verifyGatewayOrigin,
} from './channel-route-shared.js';
import { handleApprovalInterception } from './guardian-approval-interception.js';

const log = getLogger('runtime-http');

/**
 * Parse a `/guardian_verify` command from message content.
 * Supports `/guardian_verify <code>`, `/guardian_verify@BotName <code>`,
 * and normalized whitespace.
 * Returns the verification code if the message is a verify command, or undefined otherwise.
 */
function parseGuardianVerifyCommand(content: string): string | undefined {
  const match = content.match(/^\/guardian_verify(?:@\S+)?\s+(\S+)/);
  return match?.[1];
}

export async function handleChannelInbound(
  req: Request,
  processMessage?: MessageProcessor,
  bearerToken?: string,
  assistantId: string = 'self',
  gatewayOriginSecret?: string,
  approvalCopyGenerator?: ApprovalCopyGenerator,
  approvalConversationGenerator?: ApprovalConversationGenerator,
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
    interface?: string;
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
    externalChatId,
    externalMessageId,
    content,
    isEdit,
    attachmentIds,
    sourceMetadata,
  } = body;

  if (!body.sourceChannel || typeof body.sourceChannel !== 'string') {
    return Response.json({ error: 'sourceChannel is required' }, { status: 400 });
  }
  // Validate and narrow to canonical ChannelId at the boundary — the gateway
  // only sends well-known channel strings, so an unknown value is rejected.
  if (!isChannelId(body.sourceChannel)) {
    return Response.json(
      { error: `Invalid sourceChannel: ${body.sourceChannel}. Valid values: ${CHANNEL_IDS.join(', ')}` },
      { status: 400 },
    );
  }

  const sourceChannel = body.sourceChannel;

  if (!body.interface || typeof body.interface !== 'string') {
    return Response.json({ error: 'interface is required' }, { status: 400 });
  }
  const sourceInterface = parseInterfaceId(body.interface);
  if (!sourceInterface) {
    return Response.json(
      { error: `Invalid interface: ${body.interface}. Valid values: ${INTERFACE_IDS.join(', ')}` },
      { status: 400 },
    );
  }

  if (!externalChatId || typeof externalChatId !== 'string') {
    return Response.json({ error: 'externalChatId is required' }, { status: 400 });
  }
  if (!externalMessageId || typeof externalMessageId !== 'string') {
    return Response.json({ error: 'externalMessageId is required' }, { status: 400 });
  }

  // Reject non-string content regardless of whether attachments are present.
  if (content != null && typeof content !== 'string') {
    return Response.json({ error: 'content must be a string' }, { status: 400 });
  }

  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;

  const hasCallbackData = typeof body.callbackData === 'string' && body.callbackData.length > 0;

  if (trimmedContent.length === 0 && !hasAttachments && !isEdit && !hasCallbackData) {
    return Response.json({ error: 'content or attachmentIds is required' }, { status: 400 });
  }

  // Canonicalize the assistant ID so all DB-facing operations use the
  // consistent 'self' key regardless of what the gateway sent.
  const canonicalAssistantId = canonicalChannelAssistantId(assistantId);
  if (canonicalAssistantId !== assistantId) {
    log.debug({ raw: assistantId, canonical: canonicalAssistantId }, 'Canonicalized channel assistant ID');
  }

  // ── Ingress ACL enforcement ──
  // Track the resolved member so the escalate branch can reference it after
  // recordInbound (where we have a conversationId).
  let resolvedMember: ReturnType<typeof findMember> = null;

  // /guardian_verify must bypass the ACL membership check — users without a
  // member record need to verify before they can be recognized as members.
  const guardianVerifyCode = parseGuardianVerifyCommand(trimmedContent);
  const isGuardianVerifyCommand = guardianVerifyCode !== undefined;

  // /start gv_<token> bootstrap commands must also bypass ACL — the user
  // hasn't been verified yet and needs to complete the bootstrap handshake.
  const rawCommandIntentForAcl = sourceMetadata?.commandIntent;
  const isBootstrapCommand = rawCommandIntentForAcl &&
    typeof rawCommandIntentForAcl === 'object' &&
    !Array.isArray(rawCommandIntentForAcl) &&
    (rawCommandIntentForAcl as Record<string, unknown>).type === 'start' &&
    typeof (rawCommandIntentForAcl as Record<string, unknown>).payload === 'string' &&
    ((rawCommandIntentForAcl as Record<string, unknown>).payload as string).startsWith('gv_');

  if (body.senderExternalUserId) {
    resolvedMember = findMember({
      assistantId: canonicalAssistantId,
      sourceChannel,
      externalUserId: body.senderExternalUserId,
      externalChatId,
    });

    if (!resolvedMember) {
      // Determine whether a /guardian_verify bypass is warranted: only allow
      // when there is a pending (unconsumed, unexpired) challenge AND no
      // active guardian binding for this (assistantId, channel).
      let denyNonMember = true;
      if (isGuardianVerifyCommand) {
        // Allow bypass when there is any consumable challenge or active
        // outbound session.  The !hasActiveBinding guard is intentionally
        // omitted: rebind sessions create a consumable challenge while a
        // binding already exists, and the identity check inside
        // validateAndConsumeChallenge prevents unauthorized takeovers.
        const hasPendingChallenge = !!getPendingChallenge(canonicalAssistantId, sourceChannel);
        const hasActiveOutboundSession = !!findActiveSession(canonicalAssistantId, sourceChannel);
        if (hasPendingChallenge || hasActiveOutboundSession) {
          denyNonMember = false;
        } else {
          log.info({ sourceChannel, hasPendingChallenge, hasActiveOutboundSession }, 'Ingress ACL: guardian_verify bypass denied');
        }
      }

      // Bootstrap deep-link commands bypass ACL only when the token
      // resolves to a real pending_bootstrap session. Without this check,
      // any `/start gv_<garbage>` would bypass the not_a_member gate and
      // fall through to normal /start processing.
      if (isBootstrapCommand) {
        const bootstrapPayload = (rawCommandIntentForAcl as Record<string, unknown>).payload as string;
        const bootstrapTokenForAcl = bootstrapPayload.slice(3); // strip 'gv_' prefix
        const bootstrapSessionForAcl = resolveBootstrapToken(canonicalAssistantId, sourceChannel, bootstrapTokenForAcl);
        if (bootstrapSessionForAcl && bootstrapSessionForAcl.status === 'pending_bootstrap') {
          denyNonMember = false;
        } else {
          log.info({ sourceChannel, hasValidBootstrapSession: false }, 'Ingress ACL: bootstrap command bypass denied — no valid pending_bootstrap session');
        }
      }

      if (denyNonMember) {
        log.info({ sourceChannel, externalUserId: body.senderExternalUserId }, 'Ingress ACL: no member record, denying');
        if (body.replyCallbackUrl) {
          try {
            await deliverChannelReply(body.replyCallbackUrl, {
              chatId: externalChatId,
              text: "Sorry, you haven't been approved to message this assistant. You can ask its Guardian for an invite.",
              assistantId,
            }, bearerToken);
          } catch (err) {
            log.error({ err, externalChatId }, 'Failed to deliver ACL rejection reply');
          }
        }
        return Response.json({ accepted: true, denied: true, reason: 'not_a_member' });
      }
    }

    if (resolvedMember) {
      if (resolvedMember.status !== 'active') {
        log.info({ sourceChannel, memberId: resolvedMember.id, status: resolvedMember.status }, 'Ingress ACL: member not active, denying');
        if (body.replyCallbackUrl) {
          try {
            await deliverChannelReply(body.replyCallbackUrl, {
              chatId: externalChatId,
              text: "Sorry, you haven't been approved to message this assistant. You can ask its Guardian for an invite.",
              assistantId,
            }, bearerToken);
          } catch (err) {
            log.error({ err, externalChatId }, 'Failed to deliver ACL rejection reply');
          }
        }
        return Response.json({ accepted: true, denied: true, reason: `member_${resolvedMember.status}` });
      }

      if (resolvedMember.policy === 'deny') {
        log.info({ sourceChannel, memberId: resolvedMember.id }, 'Ingress ACL: member policy deny');
        if (body.replyCallbackUrl) {
          try {
            await deliverChannelReply(body.replyCallbackUrl, {
              chatId: externalChatId,
              text: "Sorry, you haven't been approved to message this assistant. You can ask its Guardian for an invite.",
              assistantId,
            }, bearerToken);
          } catch (err) {
            log.error({ err, externalChatId }, 'Failed to deliver ACL rejection reply');
          }
        }
        return Response.json({ accepted: true, denied: true, reason: 'policy_deny' });
      }

      // 'allow' or 'escalate' — update last seen and continue
      updateLastSeen(resolvedMember.id);
    }
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
      { sourceMessageId, assistantId: canonicalAssistantId },
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
    { sourceMessageId, assistantId: canonicalAssistantId },
  );

  const replyCallbackUrl = body.replyCallbackUrl;

  // ── Retry pending verification reply on duplicate ──
  // If a previous verification delivery failed and stored a pending reply,
  // gateway retries (duplicates) re-attempt delivery here. On success the
  // pending marker is cleared so further duplicates short-circuit normally.
  if (result.duplicate && replyCallbackUrl) {
    const pendingReply = channelDeliveryStore.getPendingVerificationReply(result.eventId);
    if (pendingReply) {
      try {
        await deliverChannelReply(replyCallbackUrl, {
          chatId: pendingReply.chatId,
          text: pendingReply.text,
          assistantId: pendingReply.assistantId,
        }, bearerToken);
        channelDeliveryStore.clearPendingVerificationReply(result.eventId);
        log.info({ eventId: result.eventId }, 'Retried pending verification reply: delivered');
      } catch (retryErr) {
        log.error({ err: retryErr, eventId: result.eventId }, 'Retry of pending verification reply failed; will retry on next duplicate');
      }
      return Response.json({
        accepted: true,
        duplicate: true,
        eventId: result.eventId,
      });
    }
  }

  // external_conversation_bindings is assistant-agnostic. Restrict writes to
  // self so assistant-scoped legacy routes do not overwrite each other's
  // channel binding metadata for the same chat.
  if (canonicalAssistantId === 'self') {
    externalConversationStore.upsertBinding({
      conversationId: result.conversationId,
      sourceChannel,
      externalChatId,
      externalUserId: body.senderExternalUserId ?? null,
      displayName: body.senderName ?? null,
      username: body.senderUsername ?? null,
    });
  }

  // ── Telegram inferred seen ──
  // Any non-duplicate telegram inbound activity (message or callback) implies
  // the user has seen previously delivered notifications in this chat.
  if (!result.duplicate && sourceChannel === 'telegram') {
    try {
      inferTelegramSeen({
        assistantId: canonicalAssistantId,
        externalChatId,
        hasCallbackData,
        callbackData: body.callbackData,
        content: trimmedContent,
      });
    } catch (err) {
      log.warn({ err, externalChatId }, 'Failed to record inferred telegram seen signal');
    }
  }

  // ── Ingress escalation ──
  // When the member's policy is 'escalate', create a pending guardian
  // approval request and halt the run. This check runs after recordInbound
  // so we have a conversationId for the approval record.
  if (resolvedMember?.policy === 'escalate') {
    const binding = getGuardianBinding(canonicalAssistantId, sourceChannel);
    if (!binding) {
      // Fail-closed: can't escalate without a guardian to route to
      log.info({ sourceChannel, memberId: resolvedMember.id }, 'Ingress ACL: escalate policy but no guardian binding, denying');
      return Response.json({ accepted: true, denied: true, reason: 'escalate_no_guardian' });
    }

    // Persist the raw payload so the decide handler can recover the original
    // message content when the escalation is approved.
    channelDeliveryStore.storePayload(result.eventId, {
      sourceChannel, interface: sourceInterface, externalChatId, externalMessageId, content,
      attachmentIds, sourceMetadata: body.sourceMetadata,
      senderName: body.senderName,
      senderExternalUserId: body.senderExternalUserId,
      senderUsername: body.senderUsername,
      replyCallbackUrl: body.replyCallbackUrl,
      assistantId: canonicalAssistantId,
    });

    createApprovalRequest({
      runId: `ingress-escalation-${Date.now()}`,
      conversationId: result.conversationId,
      assistantId: canonicalAssistantId,
      channel: sourceChannel,
      requesterExternalUserId: body.senderExternalUserId ?? '',
      requesterChatId: externalChatId,
      guardianExternalUserId: binding.guardianExternalUserId,
      guardianChatId: binding.guardianDeliveryChatId,
      toolName: 'ingress_message',
      riskLevel: 'escalated_ingress',
      reason: 'Ingress policy requires guardian approval',
      expiresAt: Date.now() + GUARDIAN_APPROVAL_TTL_MS,
    });

    // Emit notification signal through the unified pipeline (fire-and-forget).
    // This lets the decision engine route escalation alerts to all configured
    // channels, supplementing the direct guardian notification below.
    void emitNotificationSignal({
      sourceEventName: 'ingress.escalation',
      sourceChannel: sourceChannel,
      sourceSessionId: result.conversationId,
      assistantId: canonicalAssistantId,
      attentionHints: {
        requiresAction: true,
        urgency: 'high',
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: {
        conversationId: result.conversationId,
        sourceChannel,
        externalChatId,
        senderIdentifier: body.senderName || body.senderUsername || body.senderExternalUserId || 'Unknown sender',
        eventId: result.eventId,
      },
      dedupeKey: `escalation:${result.eventId}`,
    });

    // Guardian escalation channel delivery is handled by the notification
    // pipeline — no legacy callback dispatch needed.
    log.info(
      { conversationId: result.conversationId },
      'Guardian escalation created — notification pipeline handles channel delivery',
    );

    return Response.json({ accepted: true, escalated: true, reason: 'policy_escalate' });
  }

  const metadataHintsRaw = sourceMetadata?.hints;
  const metadataHints = Array.isArray(metadataHintsRaw)
    ? metadataHintsRaw.filter((hint): hint is string => typeof hint === 'string' && hint.trim().length > 0)
    : [];
  const metadataUxBrief = typeof sourceMetadata?.uxBrief === 'string' && sourceMetadata.uxBrief.trim().length > 0
    ? sourceMetadata.uxBrief.trim()
    : undefined;

  // Extract channel command intent (e.g. /start from Telegram)
  const rawCommandIntent = sourceMetadata?.commandIntent;
  let commandIntent = rawCommandIntent && typeof rawCommandIntent === 'object' && !Array.isArray(rawCommandIntent)
    ? rawCommandIntent as Record<string, unknown>
    : undefined;

  // Preserve locale from sourceMetadata so the model can greet in the user's language
  const sourceLanguageCode = typeof sourceMetadata?.languageCode === 'string' && sourceMetadata.languageCode.trim().length > 0
    ? sourceMetadata.languageCode.trim()
    : undefined;

  // ── Telegram bootstrap deep-link handling ──
  // Intercept /start gv_<token> commands BEFORE the guardian_verify intercept.
  // When a user clicks the deep link, Telegram sends /start gv_<token> which
  // the gateway forwards with commandIntent: { type: 'start', payload: 'gv_<token>' }.
  // We resolve the bootstrap token, bind the session identity, create a new
  // identity-bound session with a fresh verification code, send it, and return.
  if (
    !result.duplicate &&
    commandIntent?.type === 'start' &&
    typeof commandIntent.payload === 'string' &&
    (commandIntent.payload as string).startsWith('gv_') &&
    body.senderExternalUserId
  ) {
    const bootstrapToken = (commandIntent.payload as string).slice(3);
    const bootstrapSession = resolveBootstrapToken(canonicalAssistantId, sourceChannel, bootstrapToken);

    if (bootstrapSession && bootstrapSession.status === 'pending_bootstrap') {
      // Bind the pending_bootstrap session to the sender's identity
      bindSessionIdentity(bootstrapSession.id, body.senderExternalUserId, externalChatId);

      // Transition bootstrap session to awaiting_response
      updateSessionStatus(bootstrapSession.id, 'awaiting_response');

      // Create a new identity-bound outbound session with a fresh secret.
      // The old bootstrap session is auto-revoked by createOutboundSession.
      const newSession = createOutboundSession({
        assistantId: canonicalAssistantId,
        channel: sourceChannel,
        expectedExternalUserId: body.senderExternalUserId,
        expectedChatId: externalChatId,
        identityBindingStatus: 'bound',
        destinationAddress: externalChatId,
      });

      // Compose and send the verification code via Telegram
      const telegramBody = composeVerificationTelegram(
        GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST,
        {
          code: newSession.secret,
          expiresInMinutes: Math.floor((newSession.expiresAt - Date.now()) / 60_000),
        },
      );

      // Deliver verification Telegram message via the gateway (fire-and-forget)
      deliverBootstrapVerificationTelegram(externalChatId, telegramBody, canonicalAssistantId);

      // Update delivery tracking
      const now = Date.now();
      updateSessionDelivery(newSession.sessionId, now, 1, now + RESEND_COOLDOWN_MS);

      return Response.json({
        accepted: true,
        duplicate: false,
        eventId: result.eventId,
        guardianVerification: 'bootstrap_bound',
      });
    }
    // If not found or expired, fall through to normal /start handling
  }

  // ── Guardian verification command intercept (deterministic) ──
  // Validate/consume the challenge synchronously so side effects (member
  // upsert, binding creation) complete before any reply. The reply is
  // delivered via template-driven deterministic messages and the command
  // is short-circuited — it NEVER enters the agent pipeline. This
  // prevents verification commands from producing agent-generated copy.
  if (
    !result.duplicate &&
    guardianVerifyCode !== undefined &&
    body.senderExternalUserId
  ) {
    const verifyResult = validateAndConsumeChallenge(
      canonicalAssistantId,
      sourceChannel,
      guardianVerifyCode,
      body.senderExternalUserId,
      externalChatId,
      body.senderUsername,
      body.senderName,
    );

    const guardianVerifyOutcome: 'verified' | 'failed' = verifyResult.success ? 'verified' : 'failed';

    if (verifyResult.success) {
      upsertMember({
        assistantId: canonicalAssistantId,
        sourceChannel,
        externalUserId: body.senderExternalUserId,
        externalChatId,
        status: 'active',
        policy: 'allow',
        displayName: body.senderName,
        username: body.senderUsername,
      });
      log.info({ sourceChannel, externalUserId: body.senderExternalUserId }, 'Guardian verified: auto-upserted ingress member');
    }

    // Deliver a deterministic template-driven reply and short-circuit.
    // Verification commands must never produce agent-generated copy.
    if (replyCallbackUrl) {
      const replyText = verifyResult.success
        ? composeChannelVerifyReply(GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_SUCCESS)
        : composeChannelVerifyReply(GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_FAILED, {
            failureReason: stripVerificationFailurePrefix(verifyResult.reason),
          });
      try {
        await deliverChannelReply(replyCallbackUrl, {
          chatId: externalChatId,
          text: replyText,
          assistantId,
        }, bearerToken);
      } catch (err) {
        // The challenge is already consumed and side effects applied, so
        // we cannot simply re-throw and let the gateway retry the full
        // flow. Instead, persist the reply so that gateway retries
        // (which arrive as duplicates) can re-attempt delivery.
        log.error({ err, externalChatId }, 'Failed to deliver deterministic verification reply; persisting for retry');
        channelDeliveryStore.storePendingVerificationReply(result.eventId, {
          chatId: externalChatId,
          text: replyText,
          assistantId,
        });

        // Self-retry after a short delay. The gateway deduplicates
        // inbound webhooks after a successful forward, so duplicate
        // retries may never arrive. This fire-and-forget retry ensures
        // delivery is re-attempted even without a gateway duplicate.
        setTimeout(async () => {
          try {
            await deliverChannelReply(replyCallbackUrl, {
              chatId: externalChatId,
              text: replyText,
              assistantId,
            }, bearerToken);
            log.info({ eventId: result.eventId }, 'Verification reply delivered on self-retry');
            channelDeliveryStore.clearPendingVerificationReply(result.eventId);
          } catch (retryErr) {
            log.error({ err: retryErr, eventId: result.eventId }, 'Verification reply self-retry also failed; pending reply remains as fallback');
          }
        }, 3000);

        return Response.json({
          accepted: true,
          duplicate: false,
          eventId: result.eventId,
          guardianVerification: guardianVerifyOutcome,
          deliveryPending: true,
        });
      }
    }

    return Response.json({
      accepted: true,
      duplicate: false,
      eventId: result.eventId,
      guardianVerification: guardianVerifyOutcome,
    });
  }

  // ── Guardian action answer interception ──
  // Check if this inbound message is a reply to a cross-channel guardian
  // action request (from a voice call). Must run before approval interception
  // so guardian answers are not mistakenly routed into the approval flow.
  if (
    !result.duplicate &&
    trimmedContent.length > 0 &&
    body.senderExternalUserId &&
    replyCallbackUrl
  ) {
    const pendingDeliveries = getPendingDeliveriesByDestination(canonicalAssistantId, sourceChannel, externalChatId);
    if (pendingDeliveries.length > 0) {
      // Identity check: only the designated guardian can answer
      const validDeliveries = pendingDeliveries.filter(
        (d) => d.destinationExternalUserId === body.senderExternalUserId,
      );

      if (validDeliveries.length > 0) {
        let matchedDelivery = validDeliveries.length === 1 ? validDeliveries[0] : null;
        let answerText = trimmedContent;

        // Multiple pending deliveries: require request code prefix for disambiguation
        if (validDeliveries.length > 1) {
          for (const d of validDeliveries) {
            const req = getGuardianActionRequest(d.requestId);
            if (req && trimmedContent.toUpperCase().startsWith(req.requestCode)) {
              matchedDelivery = d;
              answerText = trimmedContent.slice(req.requestCode.length).trim();
              break;
            }
          }

          if (!matchedDelivery) {
            // Send disambiguation message listing the request codes
            const codes = validDeliveries
              .map((d) => {
                const req = getGuardianActionRequest(d.requestId);
                return req ? req.requestCode : null;
              })
              .filter(Boolean);
            try {
              await deliverChannelReply(replyCallbackUrl, {
                chatId: externalChatId,
                text: `You have multiple pending guardian questions. Please prefix your reply with the reference code (${codes.join(', ')}) to indicate which question you are answering.`,
                assistantId,
              }, bearerToken);
            } catch (err) {
              log.error({ err, externalChatId }, 'Failed to deliver guardian action disambiguation message');
            }
            return Response.json({
              accepted: true,
              duplicate: false,
              eventId: result.eventId,
              guardianAnswer: 'disambiguation_sent',
            });
          }
        }

        if (matchedDelivery) {
          const request = getGuardianActionRequest(matchedDelivery.requestId);
          if (request) {
            // Attempt to deliver the answer to the call first. Only resolve
            // the guardian action request if answerCall succeeds, so that a
            // failed delivery (e.g. pending question timed out) leaves the
            // request pending for retry from another channel.
            const answerResult = await answerCall({ callSessionId: request.callSessionId, answer: answerText });

            if (!('ok' in answerResult) || !answerResult.ok) {
              const errorMsg = 'error' in answerResult ? answerResult.error : 'Unknown error';
              log.warn({ callSessionId: request.callSessionId, error: errorMsg }, 'answerCall failed for guardian answer');
              try {
                await deliverChannelReply(replyCallbackUrl, {
                  chatId: externalChatId,
                  text: 'Failed to deliver your answer to the call. Please try again.',
                  assistantId,
                }, bearerToken);
              } catch (deliverErr) {
                log.error({ err: deliverErr, externalChatId }, 'Failed to deliver guardian answer failure notice');
              }
              return Response.json({
                accepted: true,
                duplicate: false,
                eventId: result.eventId,
                guardianAnswer: 'answer_failed',
              });
            }

            const resolved = resolveGuardianActionRequest(
              request.id,
              answerText,
              sourceChannel,
              body.senderExternalUserId,
            );

            if (resolved) {
              return Response.json({
                accepted: true,
                duplicate: false,
                eventId: result.eventId,
                guardianAnswer: 'resolved',
              });
            } else {
              // Already answered from another channel
              try {
                await deliverChannelReply(replyCallbackUrl, {
                  chatId: externalChatId,
                  text: 'This question has already been answered from another channel.',
                  assistantId,
                }, bearerToken);
              } catch (err) {
                log.error({ err, externalChatId }, 'Failed to deliver guardian action stale notice');
              }
              return Response.json({
                accepted: true,
                duplicate: false,
                eventId: result.eventId,
                guardianAnswer: 'stale',
              });
            }
          }
        }
      }
    }
  }

  // ── Actor role resolution ──
  // Uses shared channel-agnostic resolution so all ingress paths classify
  // guardian vs non-guardian actors the same way.
  const guardianCtx: GuardianContext = resolveGuardianContext({
    assistantId: canonicalAssistantId,
    sourceChannel,
    externalChatId,
    senderExternalUserId: body.senderExternalUserId,
    senderUsername: body.senderUsername,
  });

  // ── Approval interception ──
  // Keep this active whenever callback context is available.
  if (
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
      guardianCtx,
      assistantId: canonicalAssistantId,
      approvalCopyGenerator,
      approvalConversationGenerator,
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
      guardianCtx: toGuardianRuntimeContext(sourceChannel, guardianCtx),
      replyCallbackUrl,
      assistantId: canonicalAssistantId,
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

    // Fire-and-forget: process the message and deliver the reply in the background.
    // The HTTP response returns immediately so the gateway webhook is not blocked.
    // The onEvent callback in processMessage registers pending interactions, and
    // approval interception (above) handles decisions via the pending-interactions tracker.
    processChannelMessageInBackground({
      processMessage,
      conversationId: result.conversationId,
      eventId: result.eventId,
      content: content ?? '',
      attachmentIds: hasAttachments ? attachmentIds : undefined,
      sourceChannel,
      sourceInterface,
      externalChatId,
      guardianCtx,
      metadataHints,
      metadataUxBrief,
      commandIntent,
      sourceLanguageCode,
      replyCallbackUrl,
      bearerToken,
      assistantId: canonicalAssistantId,
    });
  }

  return Response.json({
    accepted: result.accepted,
    duplicate: result.duplicate,
    eventId: result.eventId,
  });
}

// ---------------------------------------------------------------------------
// Background message processing
// ---------------------------------------------------------------------------

interface BackgroundProcessingParams {
  processMessage: MessageProcessor;
  conversationId: string;
  eventId: string;
  content: string;
  attachmentIds?: string[];
  sourceChannel: ChannelId;
  sourceInterface: InterfaceId;
  externalChatId: string;
  guardianCtx: GuardianContext;
  metadataHints: string[];
  metadataUxBrief?: string;
  replyCallbackUrl?: string;
  bearerToken?: string;
  assistantId?: string;
  commandIntent?: Record<string, unknown>;
  sourceLanguageCode?: string;
}

const TELEGRAM_TYPING_INTERVAL_MS = 4_000;

function shouldEmitTelegramTyping(
  sourceChannel: ChannelId,
  replyCallbackUrl?: string,
): boolean {
  if (sourceChannel !== 'telegram' || !replyCallbackUrl) return false;
  try {
    return new URL(replyCallbackUrl).pathname.endsWith('/deliver/telegram');
  } catch {
    return replyCallbackUrl.endsWith('/deliver/telegram');
  }
}

function startTelegramTypingHeartbeat(
  callbackUrl: string,
  chatId: string,
  bearerToken?: string,
  assistantId?: string,
): () => void {
  let active = true;
  let inFlight = false;

  const emitTyping = (): void => {
    if (!active || inFlight) return;
    inFlight = true;
    void deliverChannelReply(
      callbackUrl,
      { chatId, chatAction: 'typing', assistantId },
      bearerToken,
    ).catch((err) => {
      log.debug({ err, chatId }, 'Failed to deliver Telegram typing indicator');
    }).finally(() => {
      inFlight = false;
    });
  };

  emitTyping();

  const interval = setInterval(emitTyping, TELEGRAM_TYPING_INTERVAL_MS);
  (interval as { unref?: () => void }).unref?.();

  return () => {
    active = false;
    clearInterval(interval);
  };
}

function processChannelMessageInBackground(params: BackgroundProcessingParams): void {
  const {
    processMessage,
    conversationId,
    eventId,
    content,
    attachmentIds,
    sourceChannel,
    sourceInterface,
    externalChatId,
    guardianCtx,
    metadataHints,
    metadataUxBrief,
    replyCallbackUrl,
    bearerToken,
    assistantId,
    commandIntent,
    sourceLanguageCode,
  } = params;

  (async () => {
    const typingCallbackUrl = shouldEmitTelegramTyping(sourceChannel, replyCallbackUrl)
      ? replyCallbackUrl
      : undefined;
    const stopTypingHeartbeat = typingCallbackUrl
      ? startTelegramTypingHeartbeat(typingCallbackUrl, externalChatId, bearerToken, assistantId)
      : undefined;

    try {
      const cmdIntent = commandIntent && typeof commandIntent.type === 'string'
        ? { type: commandIntent.type as string, ...(typeof commandIntent.payload === 'string' ? { payload: commandIntent.payload } : {}), ...(sourceLanguageCode ? { languageCode: sourceLanguageCode } : {}) }
        : undefined;
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
          ...(cmdIntent ? { commandIntent: cmdIntent } : {}),
        },
        sourceChannel,
        sourceInterface,
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
    } finally {
      stopTypingHeartbeat?.();
    }
  })();
}

// ---------------------------------------------------------------------------
// Bootstrap verification Telegram delivery helper
// ---------------------------------------------------------------------------

/**
 * Deliver a verification Telegram message during bootstrap.
 * Fire-and-forget with error logging and a single self-retry on failure.
 */
function deliverBootstrapVerificationTelegram(
  chatId: string,
  text: string,
  assistantId: string,
): void {
  const attemptDelivery = async (): Promise<boolean> => {
    const gatewayUrl = getGatewayInternalBaseUrl();
    const bearerToken = readHttpToken();
    if (!bearerToken) {
      log.error('Cannot deliver bootstrap verification Telegram message: no runtime HTTP token available');
      return false;
    }
    const url = `${gatewayUrl}/deliver/telegram`;
    const resp = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ chatId, text, assistantId }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => '<unreadable>');
      log.error({ chatId, assistantId, status: resp.status, body }, 'Gateway /deliver/telegram failed for bootstrap verification');
      return false;
    }
    return true;
  };

  (async () => {
    try {
      const delivered = await attemptDelivery();
      if (delivered) {
        log.info({ chatId, assistantId }, 'Bootstrap verification Telegram message delivered');
        return;
      }
    } catch (err) {
      log.error({ err, chatId, assistantId }, 'Failed to deliver bootstrap verification Telegram message');
    }

    // Self-retry after a short delay. The gateway deduplicates inbound
    // webhooks after a successful forward, so duplicate retries from the
    // user re-clicking the deep link may never arrive. This ensures
    // delivery is re-attempted even without a gateway duplicate.
    setTimeout(async () => {
      try {
        const delivered = await attemptDelivery();
        if (delivered) {
          log.info({ chatId, assistantId }, 'Bootstrap verification Telegram message delivered on self-retry');
        } else {
          log.error({ chatId, assistantId }, 'Bootstrap verification Telegram self-retry also failed');
        }
      } catch (retryErr) {
        log.error({ err: retryErr, chatId, assistantId }, 'Bootstrap verification Telegram self-retry threw; giving up');
      }
    }, 3000);
  })();
}

// ---------------------------------------------------------------------------
// Telegram inferred-seen signal
// ---------------------------------------------------------------------------

/** Truncate a string to a reasonable evidence snippet length. */
function truncateEvidence(text: string, maxLen: number = 120): string {
  if (text.length <= maxLen) return text;
  return text.slice(0, maxLen - 1) + '\u2026';
}

/**
 * Returns true if the text looks like a bare UUID or structured ID payload
 * that carries no meaningful evidence value for a human reader.
 */
function isUuidOnlyPayload(text: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(text.trim());
}

interface InferTelegramSeenParams {
  assistantId: string;
  externalChatId: string;
  hasCallbackData: boolean;
  callbackData?: string;
  content: string;
}

/**
 * When Telegram inbound activity arrives, infer that the user has "seen"
 * the most recent unseen notification delivered to this chat. Records an
 * inferred interaction (replied or callback_clicked) and sets seen_at
 * via markDeliverySeen if not already set.
 */
function inferTelegramSeen(params: InferTelegramSeenParams): void {
  const { assistantId, externalChatId, hasCallbackData, callbackData, content } = params;

  const delivery = findLatestUnseenTelegramDelivery(assistantId, externalChatId);
  if (!delivery) return;

  const now = Date.now();
  const isCallback = hasCallbackData && typeof callbackData === 'string' && callbackData.length > 0;

  const interactionType = isCallback ? 'callback_clicked' as const : 'replied' as const;
  const source = isCallback ? 'telegram_callback_query' as const : 'telegram_inbound_message' as const;

  // Build a concise evidence snippet, skipping UUID-only payloads
  const rawEvidence = isCallback ? callbackData! : content;
  const evidenceText = rawEvidence.length > 0 && !isUuidOnlyPayload(rawEvidence)
    ? truncateEvidence(rawEvidence)
    : undefined;

  // Record the interaction. recordNotificationDeliveryInteraction also sets
  // seen_at on first write, so no separate markDeliverySeen call is needed.
  recordNotificationDeliveryInteraction({
    id: crypto.randomUUID(),
    notificationDeliveryId: delivery.id,
    assistantId: delivery.assistantId,
    channel: delivery.channel,
    interactionType,
    confidence: 'inferred',
    source,
    evidenceText,
    occurredAt: now,
  });
}
