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
  getPendingApprovalForRun,
  updateApprovalDecision,
} from '../../memory/channel-guardian-store.js';
import * as conversationStore from '../../memory/conversation-store.js';
import * as externalConversationStore from '../../memory/external-conversation-store.js';
import {
  getGuardianActionRequest,
  getPendingDeliveriesByDestination,
  resolveGuardianActionRequest,
} from '../../memory/guardian-action-store.js';
import { refreshThreadEscalation } from '../../memory/inbox-escalation-projection.js';
import { findMember, updateLastSeen, upsertMember } from '../../memory/ingress-member-store.js';
import { getPendingConfirmationsByConversation } from '../../memory/runs-store.js';
import { emitNotificationSignal } from '../../notifications/emit-signal.js';
import { checkIngressForSecrets } from '../../security/secret-ingress.js';
import { getGatewayInternalBaseUrl } from '../../config/env.js';
import { IngressBlockedError } from '../../util/errors.js';
import { getLogger } from '../../util/logger.js';
import { readHttpToken } from '../../util/platform.js';
import { composeApprovalMessageGenerative } from '../approval-message-composer.js';
import {
  buildApprovalUIMetadata,
  buildGuardianApprovalPrompt,
  getChannelApprovalPrompt,
  handleChannelDecision,
} from '../channel-approvals.js';
import {
  createOutboundSession,
  getGuardianBinding,
  getPendingChallenge,
  validateAndConsumeChallenge,
  resolveBootstrapToken,
  bindSessionIdentity,
  updateSessionStatus,
  updateSessionDelivery,
} from '../channel-guardian-service.js';
import { deliverChannelReply } from '../gateway-client.js';
import {
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from '../guardian-verification-templates.js';
import { resolveGuardianContext } from '../guardian-context-resolver.js';
import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  MessageProcessor,
} from '../http-types.js';
import type { RunOrchestrator } from '../run-orchestrator.js';
import { deliverReplyViaCallback } from './channel-delivery-routes.js';
import {
  buildGuardianDenyContext,
  buildPromptDeliveryFailureContext,
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
import { deliverGeneratedApprovalPrompt } from './guardian-approval-prompt.js';

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
  runOrchestrator?: RunOrchestrator,
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
        const hasActiveBinding = !!getGuardianBinding(canonicalAssistantId, sourceChannel);
        const hasPendingChallenge = !!getPendingChallenge(canonicalAssistantId, sourceChannel);
        if (!hasActiveBinding && hasPendingChallenge) {
          denyNonMember = false;
        } else {
          log.info({ sourceChannel, hasActiveBinding, hasPendingChallenge }, 'Ingress ACL: guardian_verify bypass denied');
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

    // Update inbox thread escalation state so the desktop UI badge is accurate
    refreshThreadEscalation(result.conversationId, canonicalAssistantId);

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

  const replyCallbackUrl = body.replyCallbackUrl;

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
      updateSessionDelivery(newSession.sessionId, now, 1, now + 60_000);

      return Response.json({
        accepted: true,
        duplicate: false,
        eventId: result.eventId,
        guardianVerification: 'bootstrap_bound',
      });
    }
    // If not found or expired, fall through to normal /start handling
  }

  // ── Guardian verification command intercept ──
  // Validate/consume the challenge synchronously so side effects (member
  // upsert, binding creation) happen before the message enters the agent
  // loop. Instead of composing a canned reply and short-circuiting, inject
  // the verification result as a commandIntent so the full assistant
  // generates a dynamic, context-aware response.
  //
  // The raw content is replaced with just the command text to prevent an
  // unapproved sender from smuggling arbitrary prompt text after the
  // verification code (the ACL bypass window would otherwise let it reach
  // the assistant pipeline).
  let guardianVerifyOutcome: 'verified' | 'failed' | undefined;
  let effectiveContent: string | undefined = content;
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
      guardianVerifyOutcome = 'verified';
    } else {
      guardianVerifyOutcome = 'failed';
    }

    // Override commandIntent so the assistant sees the verification result
    // and can generate a natural, personalized response.
    commandIntent = {
      type: 'guardian_verify',
      payload: verifyResult.success
        ? 'success: The user has been verified and is now set as the guardian for this channel.'
        : `failed: ${stripVerificationFailurePrefix(verifyResult.reason)}`,
    };

    // Sanitize content to only the command itself — strip any arbitrary
    // text the sender may have appended after the verification code.
    effectiveContent = `/guardian_verify ${guardianVerifyCode}`;
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
      sourceChannel, externalChatId, externalMessageId, content: effectiveContent,
      attachmentIds, sourceMetadata: body.sourceMetadata,
      senderName: body.senderName,
      senderExternalUserId: body.senderExternalUserId,
      senderUsername: body.senderUsername,
      guardianCtx: toGuardianRuntimeContext(sourceChannel, guardianCtx),
      replyCallbackUrl,
      assistantId: canonicalAssistantId,
    });

    const contentToCheck = effectiveContent ?? '';
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
        content: effectiveContent ?? '',
        attachmentIds: hasAttachments ? attachmentIds : undefined,
        externalChatId,
        sourceChannel,
        sourceInterface,
        replyCallbackUrl,
        bearerToken,
        guardianCtx,
        assistantId: canonicalAssistantId,
        metadataHints,
        metadataUxBrief,
        commandIntent,
        sourceLanguageCode,
        approvalCopyGenerator,
      });
    } else {
      // Fire-and-forget: process the message and deliver the reply in the background.
      // The HTTP response returns immediately so the gateway webhook is not blocked.
      processChannelMessageInBackground({
        processMessage,
        conversationId: result.conversationId,
        eventId: result.eventId,
        content: effectiveContent ?? '',
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
  }

  return Response.json({
    accepted: result.accepted,
    duplicate: result.duplicate,
    eventId: result.eventId,
    ...(guardianVerifyOutcome ? { guardianVerification: guardianVerifyOutcome } : {}),
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
    }
  })();
}

// ---------------------------------------------------------------------------
// Orchestrator-backed channel processing with approval prompt delivery
// ---------------------------------------------------------------------------

interface ApprovalProcessingParams {
  orchestrator: RunOrchestrator;
  conversationId: string;
  eventId: string;
  content: string;
  attachmentIds?: string[];
  externalChatId: string;
  sourceChannel: ChannelId;
  sourceInterface: InterfaceId;
  replyCallbackUrl: string;
  bearerToken?: string;
  guardianCtx: GuardianContext;
  assistantId: string;
  metadataHints: string[];
  metadataUxBrief?: string;
  commandIntent?: Record<string, unknown>;
  sourceLanguageCode?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
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
    sourceInterface,
    replyCallbackUrl,
    bearerToken,
    guardianCtx,
    assistantId,
    metadataHints,
    metadataUxBrief,
    commandIntent,
    sourceLanguageCode,
    approvalCopyGenerator,
  } = params;

  const isNonGuardian = guardianCtx.actorRole === 'non-guardian';
  const isUnverifiedChannel = guardianCtx.actorRole === 'unverified_channel';

  const cmdIntent = commandIntent && typeof commandIntent.type === 'string'
    ? { type: commandIntent.type as string, ...(typeof commandIntent.payload === 'string' ? { payload: commandIntent.payload } : {}), ...(sourceLanguageCode ? { languageCode: sourceLanguageCode } : {}) }
    : undefined;

  (async () => {
    try {
      const turnChannelContext: import('../../channels/types.js').TurnChannelContext = {
        userMessageChannel: sourceChannel,
        assistantMessageChannel: sourceChannel,
      };

      const { run } = await orchestrator.startRun(
        conversationId,
        content,
        attachmentIds,
        {
          ...((isNonGuardian || isUnverifiedChannel) ? { forceStrictSideEffects: true } : {}),
          sourceChannel,
          sourceInterface,
          hints: metadataHints.length > 0 ? metadataHints : undefined,
          uxBrief: metadataUxBrief,
          assistantId,
          guardianContext: toGuardianRuntimeContext(sourceChannel, guardianCtx),
          ...(cmdIntent ? { commandIntent: cmdIntent } : {}),
          turnChannelContext,
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

            const guardianNotified = await deliverGeneratedApprovalPrompt({
              replyCallbackUrl,
              chatId: guardianCtx.guardianChatId,
              sourceChannel,
              assistantId,
              bearerToken,
              prompt: guardianPrompt,
              uiMetadata,
              messageContext: {
                scenario: 'guardian_prompt',
                toolName: pending[0].toolName,
                requesterIdentifier: guardianCtx.requesterIdentifier ?? 'Unknown user',
              },
              approvalCopyGenerator,
            });

            if (guardianNotified) {
              hasPostDecisionDelivery = true;
            } else {
              // Deny the approval and the underlying run — fail-closed. If
              // the prompt could not be delivered, the guardian will never see
              // it, so the safest action is to deny rather than cancel (which
              // would allow requester fallback).
              updateApprovalDecision(approvalReqRecord.id, { status: 'denied' });
              handleChannelDecision(
                conversationId,
                { action: 'reject', source: 'plain_text' },
                orchestrator,
                buildPromptDeliveryFailureContext(pending[0].toolName),
              );
            }

            // Only notify the requester if the guardian prompt was actually delivered
            if (guardianNotified) {
              try {
                const forwardedText = await composeApprovalMessageGenerative({
                  scenario: 'guardian_request_forwarded',
                  toolName: pending[0].toolName,
                  channel: sourceChannel,
                }, {}, approvalCopyGenerator);
                await deliverChannelReply(replyCallbackUrl, {
                  chatId: guardianCtx.requesterChatId ?? externalChatId,
                  text: forwardedText,
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
              const delivered = await deliverGeneratedApprovalPrompt({
                replyCallbackUrl,
                chatId: externalChatId,
                sourceChannel,
                assistantId,
                bearerToken,
                prompt,
                uiMetadata,
                messageContext: {
                  scenario: 'standard_prompt',
                  toolName: pending[0].toolName,
                },
                approvalCopyGenerator,
              });
              if (delivered) {
                hasPostDecisionDelivery = true;
              } else {
                // Fail-closed: if we cannot deliver the approval prompt, the
                // user will never see it and the run would hang indefinitely
                // in needs_confirmation. Auto-deny to avoid silent wait states.
                log.error(
                  { runId: run.id, conversationId },
                  'Failed to deliver standard approval prompt; auto-denying (fail-closed)',
                );
                handleChannelDecision(
                  conversationId,
                  { action: 'reject', source: 'plain_text' },
                  orchestrator,
                  buildPromptDeliveryFailureContext(pending[0].toolName),
                );
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
// Bootstrap verification Telegram delivery helper
// ---------------------------------------------------------------------------

/**
 * Deliver a verification Telegram message during bootstrap.
 * Fire-and-forget with error logging.
 */
function deliverBootstrapVerificationTelegram(
  chatId: string,
  text: string,
  assistantId: string,
): void {
  (async () => {
    try {
      const gatewayUrl = getGatewayInternalBaseUrl();
      const bearerToken = readHttpToken();
      if (!bearerToken) {
        log.error('Cannot deliver bootstrap verification Telegram message: no runtime HTTP token available');
        return;
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
      } else {
        log.info({ chatId, assistantId }, 'Bootstrap verification Telegram message delivered');
      }
    } catch (err) {
      log.error({ err, chatId, assistantId }, 'Failed to deliver bootstrap verification Telegram message');
    }
  })();
}
