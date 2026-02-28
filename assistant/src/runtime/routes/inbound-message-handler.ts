/**
 * Channel inbound message handler: validates, records, and routes inbound
 * messages from all channels. Handles ingress ACL, edits, guardian
 * verification, guardian action answers, approval interception, and
 * invite token redemption.
 */
// Side-effect import: registers the Telegram invite transport adapter so
// getTransport('telegram') resolves at runtime.
import type { ChannelId, InterfaceId } from '../../channels/types.js';
import { CHANNEL_IDS, INTERFACE_IDS, isChannelId, parseInterfaceId } from '../../channels/types.js';
import { getGatewayInternalBaseUrl } from '../../config/env.js';
import { RESEND_COOLDOWN_MS } from '../../daemon/handlers/config-channels.js';
import * as attachmentsStore from '../../memory/attachments-store.js';
import * as channelDeliveryStore from '../../memory/channel-delivery-store.js';
import {
  createCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
} from '../../memory/canonical-guardian-store.js';
import { recordConversationSeenSignal } from '../../memory/conversation-attention-store.js';
import * as conversationStore from '../../memory/conversation-store.js';
import * as externalConversationStore from '../../memory/external-conversation-store.js';
import { findMember, updateLastSeen, upsertMember } from '../../memory/ingress-member-store.js';
import { emitNotificationSignal } from '../../notifications/emit-signal.js';
import { checkIngressForSecrets } from '../../security/secret-ingress.js';
import { canonicalizeInboundIdentity } from '../../util/canonicalize-identity.js';
import { IngressBlockedError } from '../../util/errors.js';
import { getLogger } from '../../util/logger.js';
import { readHttpToken } from '../../util/platform.js';
import {
  buildApprovalUIMetadata,
  getApprovalInfoByConversation,
  getChannelApprovalPrompt,
} from '../channel-approvals.js';
import {
  bindSessionIdentity,
  createOutboundSession,
  findActiveSession,
  getGuardianBinding,
  getPendingChallenge,
  resolveBootstrapToken,
  updateSessionDelivery,
  updateSessionStatus,
  validateAndConsumeChallenge,
} from '../channel-guardian-service.js';
import { getTransport } from '../channel-invite-transport.js';
import { deliverChannelReply } from '../gateway-client.js';
import { resolveGuardianContext } from '../guardian-context-resolver.js';
import {
  composeChannelVerifyReply,
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from '../guardian-verification-templates.js';
import { httpError } from '../http-errors.js';
import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
  MessageProcessor,
} from '../http-types.js';
import { redeemInvite } from '../invite-redemption-service.js';
import { getInviteRedemptionReply } from '../invite-redemption-templates.js';
import { deliverReplyViaCallback } from './channel-delivery-routes.js';
import {
  canonicalChannelAssistantId,
  GUARDIAN_APPROVAL_TTL_MS,
  type GuardianContext,
  stripVerificationFailurePrefix,
  toGuardianRuntimeContext,
  verifyGatewayOrigin,
} from './channel-route-shared.js';
import { handleApprovalInterception } from './guardian-approval-interception.js';
import { deliverGeneratedApprovalPrompt } from './guardian-approval-prompt.js';
import { routeGuardianReply } from '../guardian-reply-router.js';

import '../channel-invite-transports/telegram.js';

const log = getLogger('runtime-http');

/**
 * Parse a guardian verification code from message content.
 * Accepts a bare code as the entire message: 6-digit numeric OR 64-char hex
 * (hex is retained for compatibility with unbound inbound/bootstrap sessions
 * that intentionally use high-entropy secrets).
 */
function parseGuardianVerifyCode(content: string): string | undefined {
  const bareMatch = content.match(/^([0-9a-fA-F]{64}|\d{6})$/);
  if (bareMatch) return bareMatch[1];

  return undefined;
}

export async function handleChannelInbound(
  req: Request,
  processMessage?: MessageProcessor,
  bearerToken?: string,
  assistantId: string = 'self',
  gatewayOriginSecret?: string,
  approvalCopyGenerator?: ApprovalCopyGenerator,
  approvalConversationGenerator?: ApprovalConversationGenerator,
  guardianActionCopyGenerator?: GuardianActionCopyGenerator,
  guardianFollowUpConversationGenerator?: GuardianFollowUpConversationGenerator,
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
    return httpError('BAD_REQUEST', 'sourceChannel is required', 400);
  }
  // Validate and narrow to canonical ChannelId at the boundary — the gateway
  // only sends well-known channel strings, so an unknown value is rejected.
  if (!isChannelId(body.sourceChannel)) {
    return httpError('BAD_REQUEST', `Invalid sourceChannel: ${body.sourceChannel}. Valid values: ${CHANNEL_IDS.join(', ')}`, 400);
  }

  const sourceChannel = body.sourceChannel;

  if (!body.interface || typeof body.interface !== 'string') {
    return httpError('BAD_REQUEST', 'interface is required', 400);
  }
  const sourceInterface = parseInterfaceId(body.interface);
  if (!sourceInterface) {
    return httpError('BAD_REQUEST', `Invalid interface: ${body.interface}. Valid values: ${INTERFACE_IDS.join(', ')}`, 400);
  }

  if (!externalChatId || typeof externalChatId !== 'string') {
    return httpError('BAD_REQUEST', 'externalChatId is required', 400);
  }
  if (!externalMessageId || typeof externalMessageId !== 'string') {
    return httpError('BAD_REQUEST', 'externalMessageId is required', 400);
  }

  // Reject non-string content regardless of whether attachments are present.
  if (content != null && typeof content !== 'string') {
    return httpError('BAD_REQUEST', 'content must be a string', 400);
  }

  const trimmedContent = typeof content === 'string' ? content.trim() : '';
  const hasAttachments = Array.isArray(attachmentIds) && attachmentIds.length > 0;

  const hasCallbackData = typeof body.callbackData === 'string' && body.callbackData.length > 0;

  if (trimmedContent.length === 0 && !hasAttachments && !isEdit && !hasCallbackData) {
    return httpError('BAD_REQUEST', 'content or attachmentIds is required', 400);
  }

  // Canonicalize the assistant ID so all DB-facing operations use the
  // consistent 'self' key regardless of what the gateway sent.
  const canonicalAssistantId = canonicalChannelAssistantId(assistantId);
  if (canonicalAssistantId !== assistantId) {
    log.debug({ raw: assistantId, canonical: canonicalAssistantId }, 'Canonicalized channel assistant ID');
  }

  // Coerce senderExternalUserId to a string at the boundary — the field
  // comes from unvalidated JSON and may be a number, object, or other
  // non-string type. Non-string truthy values would throw inside
  // canonicalizeInboundIdentity when it calls .trim().
  const rawSenderId = body.senderExternalUserId != null
    ? String(body.senderExternalUserId)
    : undefined;

  // Canonicalize the sender identity so all trust lookups, member matching,
  // and guardian binding comparisons use a normalized form. Phone-like
  // channels (sms, voice, whatsapp) are normalized to E.164; non-phone
  // channels pass through the platform-stable ID unchanged.
  const canonicalSenderId = rawSenderId
    ? canonicalizeInboundIdentity(sourceChannel, rawSenderId)
    : null;

  // Track whether the original payload included a sender identity. A
  // whitespace-only senderExternalUserId canonicalizes to null but still
  // represents an explicit (malformed) identity claim that must enter the
  // ACL deny path rather than bypassing it.
  const hasSenderIdentityClaim = rawSenderId !== undefined;

  // ── Ingress ACL enforcement ──
  // Track the resolved member so the escalate branch can reference it after
  // recordInbound (where we have a conversationId).
  let resolvedMember: ReturnType<typeof findMember> = null;

  // Verification codes must bypass the ACL membership check — users without a
  // member record need to verify before they can be recognized as members.
  const guardianVerifyCode = parseGuardianVerifyCode(trimmedContent);
  const isGuardianVerifyCode = guardianVerifyCode !== undefined;

  // /start gv_<token> bootstrap commands must also bypass ACL — the user
  // hasn't been verified yet and needs to complete the bootstrap handshake.
  const rawCommandIntentForAcl = sourceMetadata?.commandIntent;
  const isBootstrapCommand = rawCommandIntentForAcl &&
    typeof rawCommandIntentForAcl === 'object' &&
    !Array.isArray(rawCommandIntentForAcl) &&
    (rawCommandIntentForAcl as Record<string, unknown>).type === 'start' &&
    typeof (rawCommandIntentForAcl as Record<string, unknown>).payload === 'string' &&
    ((rawCommandIntentForAcl as Record<string, unknown>).payload as string).startsWith('gv_');

  // Parse invite token from /start iv_<token> commands using the transport
  // adapter. The token is extracted once here so both the ACL bypass and
  // the intercept handler can reference it without re-parsing.
  const commandIntentForAcl = rawCommandIntentForAcl && typeof rawCommandIntentForAcl === 'object' && !Array.isArray(rawCommandIntentForAcl)
    ? rawCommandIntentForAcl as Record<string, unknown>
    : undefined;
  const inviteTransport = getTransport(sourceChannel);
  const inviteToken = inviteTransport?.extractInboundToken({
    commandIntent: commandIntentForAcl,
    content: trimmedContent,
    sourceMetadata: body.sourceMetadata,
  });

  if (canonicalSenderId || hasSenderIdentityClaim) {
    // Only perform member lookup when we have a usable canonical ID.
    // Whitespace-only senders (hasSenderIdentityClaim=true but
    // canonicalSenderId=null) skip the lookup and fall into the deny path.
    if (canonicalSenderId) {
      resolvedMember = findMember({
        assistantId: canonicalAssistantId,
        sourceChannel,
        externalUserId: canonicalSenderId,
        externalChatId,
      });
    }

    if (!resolvedMember) {
      // Determine whether a verification-code bypass is warranted: only allow
      // when there is a pending (unconsumed, unexpired) challenge AND no
      // active guardian binding for this (assistantId, channel).
      let denyNonMember = true;
      if (isGuardianVerifyCode) {
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
          log.info({ sourceChannel, hasPendingChallenge, hasActiveOutboundSession }, 'Ingress ACL: guardian verification bypass denied');
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

      // ── Invite token intercept (non-member) ──
      // /start iv_<token> deep links grant access without guardian approval.
      // Intercept here — before the deny gate — so valid invites short-circuit
      // the ACL rejection and never reach the agent pipeline.
      if (inviteToken && denyNonMember) {
        const inviteResult = await handleInviteTokenIntercept({
          rawToken: inviteToken,
          sourceChannel,
          externalChatId,
          externalMessageId,
          senderExternalUserId: canonicalSenderId ?? body.senderExternalUserId,
          senderName: body.senderName,
          senderUsername: body.senderUsername,
          replyCallbackUrl: body.replyCallbackUrl,
          bearerToken,
          assistantId,
          canonicalAssistantId,
        });
        if (inviteResult) return inviteResult;
      }

      if (denyNonMember) {
        log.info({ sourceChannel, externalUserId: canonicalSenderId }, 'Ingress ACL: no member record, denying');

        // Notify the guardian about the access request so they can approve/deny.
        // Only fires when a guardian binding exists and no duplicate pending
        // request already exists for this requester.
        let guardianNotified = false;
        try {
          guardianNotified = notifyGuardianOfAccessRequest({
            canonicalAssistantId,
            sourceChannel,
            externalChatId,
            senderExternalUserId: canonicalSenderId ?? body.senderExternalUserId,
            senderName: body.senderName,
            senderUsername: body.senderUsername,
          });
        } catch (err) {
          log.error({ err, sourceChannel, externalChatId }, 'Failed to notify guardian of access request');
        }

        if (body.replyCallbackUrl) {
          const replyText = guardianNotified
            ? "Hmm looks like you don't have access to talk to me. I'll let them know you tried talking to me and get back to you."
            : "Sorry, you haven't been approved to message this assistant.";
          try {
            await deliverChannelReply(body.replyCallbackUrl, {
              chatId: externalChatId,
              text: replyText,
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
        // Same bypass logic as the no-member branch: verification codes and
        // bootstrap commands must pass through even when the member record is
        // revoked/blocked — otherwise the user can never re-verify.
        let denyInactiveMember = true;
        if (isGuardianVerifyCode) {
          const hasPendingChallenge = !!getPendingChallenge(canonicalAssistantId, sourceChannel);
          const hasActiveOutboundSession = !!findActiveSession(canonicalAssistantId, sourceChannel);
          if (hasPendingChallenge || hasActiveOutboundSession) {
            denyInactiveMember = false;
          } else {
            log.info({ sourceChannel, memberId: resolvedMember.id, hasPendingChallenge, hasActiveOutboundSession }, 'Ingress ACL: inactive member verification bypass denied');
          }
        }
        if (isBootstrapCommand) {
          const bootstrapPayload = (rawCommandIntentForAcl as Record<string, unknown>).payload as string;
          const bootstrapTokenForAcl = bootstrapPayload.slice(3);
          const bootstrapSessionForAcl = resolveBootstrapToken(canonicalAssistantId, sourceChannel, bootstrapTokenForAcl);
          if (bootstrapSessionForAcl && bootstrapSessionForAcl.status === 'pending_bootstrap') {
            denyInactiveMember = false;
          } else {
            log.info({ sourceChannel, memberId: resolvedMember.id, hasValidBootstrapSession: false }, 'Ingress ACL: inactive member bootstrap bypass denied');
          }
        }

        // ── Invite token intercept (inactive member) ──
        // Same as the non-member branch: invite tokens can reactivate
        // revoked/pending members without requiring guardian approval.
        if (inviteToken && denyInactiveMember) {
          const inviteResult = await handleInviteTokenIntercept({
            rawToken: inviteToken,
            sourceChannel,
            externalChatId,
            externalMessageId,
            senderExternalUserId: canonicalSenderId ?? body.senderExternalUserId,
            senderName: body.senderName,
            senderUsername: body.senderUsername,
            replyCallbackUrl: body.replyCallbackUrl,
            bearerToken,
            assistantId,
            canonicalAssistantId,
          });
          if (inviteResult) return inviteResult;
        }

        if (denyInactiveMember) {
          log.info({ sourceChannel, memberId: resolvedMember.id, status: resolvedMember.status }, 'Ingress ACL: member not active, denying');

          // For revoked/pending members, notify the guardian so they can
          // re-approve. Blocked members are intentionally excluded — the
          // guardian already made an explicit decision to block them.
          let guardianNotified = false;
          if (resolvedMember.status !== 'blocked') {
            try {
              guardianNotified = notifyGuardianOfAccessRequest({
                canonicalAssistantId,
                sourceChannel,
                externalChatId,
                senderExternalUserId: canonicalSenderId ?? body.senderExternalUserId,
                senderName: body.senderName,
                senderUsername: body.senderUsername,
              });
            } catch (err) {
              log.error({ err, sourceChannel, externalChatId }, 'Failed to notify guardian of access request');
            }
          }

          if (body.replyCallbackUrl) {
            const replyText = guardianNotified
              ? "Hmm looks like you don't have access to talk to me. I'll let them know you tried talking to me and get back to you."
              : "Sorry, you haven't been approved to message this assistant.";
            try {
              await deliverChannelReply(body.replyCallbackUrl, {
                chatId: externalChatId,
                text: replyText,
                assistantId,
              }, bearerToken);
            } catch (err) {
              log.error({ err, externalChatId }, 'Failed to deliver ACL rejection reply');
            }
          }
          return Response.json({ accepted: true, denied: true, reason: `member_${resolvedMember.status}` });
        }
      }

      if (resolvedMember.policy === 'deny') {
        log.info({ sourceChannel, memberId: resolvedMember.id }, 'Ingress ACL: member policy deny');
        if (body.replyCallbackUrl) {
          try {
            await deliverChannelReply(body.replyCallbackUrl, {
              chatId: externalChatId,
              text: "Sorry, you haven't been approved to message this assistant.",
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
    return httpError('BAD_REQUEST', 'sourceMetadata.messageId is required for edits', 400);
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
      externalUserId: canonicalSenderId ?? body.senderExternalUserId ?? null,
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

    createCanonicalGuardianRequest({
      kind: 'tool_approval',
      sourceType: 'channel',
      sourceChannel,
      conversationId: result.conversationId,
      requesterExternalUserId: canonicalSenderId ?? body.senderExternalUserId ?? undefined,
      guardianExternalUserId: binding.guardianExternalUserId,
      toolName: 'ingress_message',
      questionText: 'Ingress policy requires guardian approval',
      expiresAt: new Date(Date.now() + GUARDIAN_APPROVAL_TTL_MS).toISOString(),
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
  const commandIntent = rawCommandIntent && typeof rawCommandIntent === 'object' && !Array.isArray(rawCommandIntent)
    ? rawCommandIntent as Record<string, unknown>
    : undefined;

  // Preserve locale from sourceMetadata so the model can greet in the user's language
  const sourceLanguageCode = typeof sourceMetadata?.languageCode === 'string' && sourceMetadata.languageCode.trim().length > 0
    ? sourceMetadata.languageCode.trim()
    : undefined;

  // ── Telegram bootstrap deep-link handling ──
  // Intercept /start gv_<token> commands BEFORE the verification-code intercept.
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

      // Compose and send the verification prompt via Telegram
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

  // ── Guardian verification code intercept (deterministic) ──
  // Validate/consume the challenge synchronously so side effects (member
  // upsert, binding creation) complete before any reply. The reply is
  // delivered via template-driven deterministic messages and the code
  // is short-circuited — it NEVER enters the agent pipeline. This
  // prevents verification code messages from producing agent-generated copy.
  //
  // Bare 6-digit codes are only intercepted when there is actually a
  // pending challenge or active outbound session for this channel.
  // Without this guard, normal 6-digit messages (zip codes, PINs, etc.)
  // would be swallowed by the verification handler and never reach the
  // agent pipeline.
  const shouldInterceptVerification = guardianVerifyCode !== undefined &&
    (!!getPendingChallenge(canonicalAssistantId, sourceChannel) ||
     !!findActiveSession(canonicalAssistantId, sourceChannel));

  if (
    !result.duplicate &&
    shouldInterceptVerification &&
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
        externalUserId: canonicalSenderId ?? body.senderExternalUserId,
        externalChatId,
        status: 'active',
        policy: 'allow',
        displayName: body.senderName,
        username: body.senderUsername,
      });

      const verifyLogLabel = verifyResult.verificationType === 'trusted_contact'
        ? 'Trusted contact verified'
        : 'Guardian verified';
      log.info({ sourceChannel, externalUserId: canonicalSenderId, verificationType: verifyResult.verificationType }, `${verifyLogLabel}: auto-upserted ingress member`);

      // Emit activated signal when a trusted contact completes verification.
      // Member record is persisted above before this event fires, satisfying
      // the persistence-before-event ordering invariant.
      if (verifyResult.verificationType === 'trusted_contact') {
        void emitNotificationSignal({
          sourceEventName: 'ingress.trusted_contact.activated',
          sourceChannel,
          sourceSessionId: result.conversationId,
          assistantId: canonicalAssistantId,
          attentionHints: {
            requiresAction: false,
            urgency: 'low',
            isAsyncBackground: false,
            visibleInSourceNow: false,
          },
          contextPayload: {
            sourceChannel,
            externalUserId: canonicalSenderId ?? body.senderExternalUserId,
            externalChatId,
            senderName: body.senderName ?? null,
            senderUsername: body.senderUsername ?? null,
          },
          dedupeKey: `trusted-contact:activated:${canonicalAssistantId}:${sourceChannel}:${canonicalSenderId ?? body.senderExternalUserId}`,
        });
      }
    }

    // Deliver a deterministic template-driven reply and short-circuit.
    // Verification code messages must never produce agent-generated copy.
    if (replyCallbackUrl) {
      let replyText: string;
      if (!verifyResult.success) {
        replyText = composeChannelVerifyReply(GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_FAILED, {
          failureReason: stripVerificationFailurePrefix(verifyResult.reason),
        });
      } else if (verifyResult.verificationType === 'trusted_contact') {
        replyText = composeChannelVerifyReply(GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_TRUSTED_CONTACT_VERIFY_SUCCESS);
      } else {
        replyText = composeChannelVerifyReply(GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_SUCCESS);
      }
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

  // Legacy voice guardian action interception removed — all guardian reply
  // routing now flows through the canonical router below (routeGuardianReply),
  // which handles request code matching, callback parsing, and NL classification
  // against canonical_guardian_requests.

  // ── Actor role resolution ──
  // Uses shared channel-agnostic resolution so all ingress paths classify
  // guardian vs non-guardian actors the same way.
  const guardianCtx: GuardianContext = resolveGuardianContext({
    assistantId: canonicalAssistantId,
    sourceChannel,
    externalChatId,
    senderExternalUserId: rawSenderId ?? body.senderExternalUserId,
    senderUsername: body.senderUsername,
  });

  // ── Canonical guardian reply router ──
  // Attempts to route inbound messages through the canonical decision pipeline
  // before falling through to the legacy approval interception. Handles
  // deterministic callbacks (button presses), request code prefixes, and
  // NL classification via the conversational approval engine.
  if (
    !result.duplicate &&
    replyCallbackUrl &&
    (trimmedContent.length > 0 || hasCallbackData) &&
    body.senderExternalUserId &&
    guardianCtx.actorRole === 'guardian'
  ) {
    const routerResult = await routeGuardianReply({
      messageText: trimmedContent,
      channel: sourceChannel,
      actor: {
        externalUserId: body.senderExternalUserId,
        channel: sourceChannel,
        isTrusted: false,
      },
      conversationId: result.conversationId,
      callbackData: body.callbackData,
      approvalConversationGenerator,
    });

    if (routerResult.consumed) {
      // Deliver reply text if the router produced one
      if (routerResult.replyText) {
        try {
          await deliverChannelReply(replyCallbackUrl, {
            chatId: externalChatId,
            text: routerResult.replyText,
            assistantId: canonicalAssistantId,
          }, bearerToken);
        } catch (err) {
          log.error({ err, externalChatId }, 'Failed to deliver canonical router reply');
        }
      }

      return Response.json({
        accepted: true,
        duplicate: false,
        eventId: result.eventId,
        canonicalRouter: routerResult.type,
        requestId: routerResult.requestId,
      });
    }
  }

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
      // Record inferred seen signal for all handled Telegram approval interactions
      if (sourceChannel === 'telegram') {
        try {
          if (hasCallbackData) {
            const cbPreview = body.callbackData!.length > 80
              ? body.callbackData!.slice(0, 80) + '...'
              : body.callbackData!;
            recordConversationSeenSignal({
              conversationId: result.conversationId,
              assistantId: canonicalAssistantId,
              signalType: 'telegram_callback',
              confidence: 'inferred',
              sourceChannel: 'telegram',
              source: 'inbound-message-handler',
              evidenceText: `User tapped callback: '${cbPreview}'`,
            });
          } else {
            const msgPreview = trimmedContent.length > 80
              ? trimmedContent.slice(0, 80) + '...'
              : trimmedContent;
            recordConversationSeenSignal({
              conversationId: result.conversationId,
              assistantId: canonicalAssistantId,
              signalType: 'telegram_inbound_message',
              confidence: 'inferred',
              sourceChannel: 'telegram',
              source: 'inbound-message-handler',
              evidenceText: `User sent plain-text approval reply: '${msgPreview}'`,
            });
          }
        } catch (err) {
          log.warn({ err, conversationId: result.conversationId }, 'Failed to record seen signal for Telegram approval interaction');
        }
      }

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
      // Record seen signal even for stale callbacks — the user still interacted
      if (sourceChannel === 'telegram') {
        try {
          const cbPreview = body.callbackData!.length > 80
            ? body.callbackData!.slice(0, 80) + '...'
            : body.callbackData!;
          recordConversationSeenSignal({
            conversationId: result.conversationId,
            assistantId: canonicalAssistantId,
            signalType: 'telegram_callback',
            confidence: 'inferred',
            sourceChannel: 'telegram',
            source: 'inbound-message-handler',
            evidenceText: `User tapped stale callback: '${cbPreview}'`,
          });
        } catch (err) {
          log.warn({ err, conversationId: result.conversationId }, 'Failed to record seen signal for stale Telegram callback');
        }
      }

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

    // Record inferred seen signal for non-duplicate Telegram inbound messages
    if (sourceChannel === 'telegram') {
      try {
        const msgPreview = trimmedContent.length > 80
          ? trimmedContent.slice(0, 80) + '...'
          : trimmedContent;
        const evidence = trimmedContent.length > 0
          ? `User sent message: '${msgPreview}'`
          : 'User sent media attachment';
        recordConversationSeenSignal({
          conversationId: result.conversationId,
          assistantId: canonicalAssistantId,
          signalType: 'telegram_inbound_message',
          confidence: 'inferred',
          sourceChannel: 'telegram',
          source: 'inbound-message-handler',
          evidenceText: evidence,
        });
      } catch (err) {
        log.warn({ err, conversationId: result.conversationId }, 'Failed to record seen signal for Telegram inbound message');
      }
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
      approvalCopyGenerator,
    });
  }

  return Response.json({
    accepted: result.accepted,
    duplicate: result.duplicate,
    eventId: result.eventId,
  });
}

// ---------------------------------------------------------------------------
// Invite token intercept
// ---------------------------------------------------------------------------

/**
 * Handle an inbound invite token for a non-member or inactive member.
 *
 * Redeems the invite, delivers a deterministic reply, and returns a Response
 * to short-circuit the handler. Returns `null` when the intercept should not
 * fire (e.g. already_member outcome — let normal flow handle it).
 */
async function handleInviteTokenIntercept(params: {
  rawToken: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  externalMessageId: string;
  senderExternalUserId?: string;
  senderName?: string;
  senderUsername?: string;
  replyCallbackUrl?: string;
  bearerToken?: string;
  assistantId?: string;
  canonicalAssistantId: string;
}): Promise<Response | null> {
  const {
    rawToken,
    sourceChannel,
    externalChatId,
    externalMessageId,
    senderExternalUserId,
    senderName,
    senderUsername,
    replyCallbackUrl,
    bearerToken,
    assistantId,
    canonicalAssistantId,
  } = params;

  // Record the inbound event for dedup tracking BEFORE performing redemption.
  // Without this, duplicate webhook deliveries (common with Telegram) would
  // not be tracked: the first delivery redeems the invite and returns early,
  // then the retry finds an active member, passes ACL, and the raw
  // /start iv_<token> message leaks into the agent pipeline.
  const dedupResult = channelDeliveryStore.recordInbound(
    sourceChannel,
    externalChatId,
    externalMessageId,
    { assistantId: canonicalAssistantId },
  );

  if (dedupResult.duplicate) {
    return Response.json({
      accepted: true,
      duplicate: true,
      eventId: dedupResult.eventId,
    });
  }

  const outcome = redeemInvite({
    rawToken,
    sourceChannel,
    externalUserId: senderExternalUserId,
    externalChatId,
    displayName: senderName,
    username: senderUsername,
    assistantId: canonicalAssistantId,
  });

  log.info(
    { sourceChannel, externalChatId, ok: outcome.ok, type: outcome.ok ? outcome.type : undefined, reason: !outcome.ok ? outcome.reason : undefined },
    'Invite token intercept: redemption result',
  );

  // already_member means the user has an active record — let the normal
  // flow handle them (they passed ACL or the member is active).
  if (outcome.ok && outcome.type === 'already_member') {
    // Deliver a quick acknowledgement and short-circuit so the user
    // does not trigger the deny gate or a duplicate agent loop.
    const replyText = getInviteRedemptionReply(outcome);
    if (replyCallbackUrl) {
      try {
        await deliverChannelReply(replyCallbackUrl, {
          chatId: externalChatId,
          text: replyText,
          assistantId,
        }, bearerToken);
      } catch (err) {
        log.error({ err, externalChatId }, 'Failed to deliver invite already-member reply');
      }
    }
    channelDeliveryStore.markProcessed(dedupResult.eventId);
    return Response.json({ accepted: true, eventId: dedupResult.eventId, inviteRedemption: 'already_member' });
  }

  const replyText = getInviteRedemptionReply(outcome);

  if (replyCallbackUrl) {
    try {
      await deliverChannelReply(replyCallbackUrl, {
        chatId: externalChatId,
        text: replyText,
        assistantId,
      }, bearerToken);
    } catch (err) {
      log.error({ err, externalChatId }, 'Failed to deliver invite redemption reply');
    }
  }

  if (outcome.ok && outcome.type === 'redeemed') {
    channelDeliveryStore.markProcessed(dedupResult.eventId);
    return Response.json({ accepted: true, eventId: dedupResult.eventId, inviteRedemption: 'redeemed', memberId: outcome.memberId });
  }

  // Failed redemption — inform the user and deny
  channelDeliveryStore.markProcessed(dedupResult.eventId);
  return Response.json({ accepted: true, eventId: dedupResult.eventId, denied: true, inviteRedemption: outcome.reason });
}

// ---------------------------------------------------------------------------
// Non-member access request notification
// ---------------------------------------------------------------------------

/**
 * Fire-and-forget: look up the guardian binding and, if present, create an
 * approval request + emit a notification signal so the guardian can
 * approve/deny the unknown user. Deduplicates by checking for an existing
 * pending approval for the same (requester, assistant, channel).
 */
function notifyGuardianOfAccessRequest(params: {
  canonicalAssistantId: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  senderExternalUserId?: string;
  senderName?: string;
  senderUsername?: string;
}): boolean {
  const {
    canonicalAssistantId,
    sourceChannel,
    externalChatId,
    senderExternalUserId,
    senderName,
    senderUsername,
  } = params;

  if (!senderExternalUserId) return false;

  const binding = getGuardianBinding(canonicalAssistantId, sourceChannel);
  if (!binding) {
    log.debug({ sourceChannel, canonicalAssistantId }, 'No guardian binding for access request notification');
    return false;
  }

  // Deduplicate: skip if there is already a pending canonical request for
  // the same requester on this channel.  Still return true — the guardian
  // was already notified for this request.
  const existingCanonical = listCanonicalGuardianRequests({
    status: 'pending',
    requesterExternalUserId: senderExternalUserId,
    sourceChannel,
    kind: 'access_request',
  });
  if (existingCanonical.length > 0) {
    log.debug(
      { sourceChannel, senderExternalUserId, existingId: existingCanonical[0].id },
      'Skipping duplicate access request notification',
    );
    return true;
  }

  const senderIdentifier = senderName || senderUsername || senderExternalUserId;
  const requestId = `access-req-${canonicalAssistantId}-${sourceChannel}-${senderExternalUserId}-${Date.now()}`;

  const canonicalRequest = createCanonicalGuardianRequest({
    id: requestId,
    kind: 'access_request',
    sourceType: 'channel',
    sourceChannel,
    conversationId: `access-req-${sourceChannel}-${senderExternalUserId}`,
    requesterExternalUserId: senderExternalUserId,
    guardianExternalUserId: binding.guardianExternalUserId,
    toolName: 'ingress_access_request',
    questionText: `${senderIdentifier} is requesting access to the assistant`,
    expiresAt: new Date(Date.now() + GUARDIAN_APPROVAL_TTL_MS).toISOString(),
  });

  void emitNotificationSignal({
    sourceEventName: 'ingress.access_request',
    sourceChannel,
    sourceSessionId: `access-req-${sourceChannel}-${senderExternalUserId}`,
    assistantId: canonicalAssistantId,
    attentionHints: {
      requiresAction: true,
      urgency: 'high',
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestId,
      sourceChannel,
      externalChatId,
      senderExternalUserId,
      senderName: senderName ?? null,
      senderUsername: senderUsername ?? null,
      senderIdentifier,
    },
    dedupeKey: `access-request:${canonicalRequest.id}`,
  });

  log.info(
    { sourceChannel, senderExternalUserId, senderIdentifier },
    'Guardian notified of non-member access request',
  );

  return true;
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
  approvalCopyGenerator?: ApprovalCopyGenerator;
  commandIntent?: Record<string, unknown>;
  sourceLanguageCode?: string;
}

const TELEGRAM_TYPING_INTERVAL_MS = 4_000;
const PENDING_APPROVAL_POLL_INTERVAL_MS = 300;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function startPendingApprovalPromptWatcher(params: {
  conversationId: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  replyCallbackUrl: string;
  bearerToken?: string;
  assistantId?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
}): () => void {
  const {
    conversationId,
    sourceChannel,
    externalChatId,
    replyCallbackUrl,
    bearerToken,
    assistantId,
    approvalCopyGenerator,
  } = params;

  let active = true;
  const deliveredRequestIds = new Set<string>();

  const poll = async (): Promise<void> => {
    while (active) {
      try {
        const prompt = getChannelApprovalPrompt(conversationId);
        const pending = getApprovalInfoByConversation(conversationId);
        const info = pending[0];
        if (prompt && info && !deliveredRequestIds.has(info.requestId)) {
          deliveredRequestIds.add(info.requestId);
          const delivered = await deliverGeneratedApprovalPrompt({
            replyCallbackUrl,
            chatId: externalChatId,
            sourceChannel,
            assistantId: assistantId ?? 'self',
            bearerToken,
            prompt,
            uiMetadata: buildApprovalUIMetadata(prompt, info),
            messageContext: {
              scenario: 'standard_prompt',
              toolName: info.toolName,
              channel: sourceChannel,
            },
            approvalCopyGenerator,
          });
          if (!delivered) {
            // Delivery can fail transiently (network or gateway outage).
            // Keep polling and retry prompt delivery for the same request.
            deliveredRequestIds.delete(info.requestId);
          }
        }
      } catch (err) {
        log.warn({ err, conversationId }, 'Pending approval prompt watcher failed');
      }
      await delay(PENDING_APPROVAL_POLL_INTERVAL_MS);
    }
  };

  void poll();
  return () => {
    active = false;
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
    approvalCopyGenerator,
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
    const stopApprovalWatcher = replyCallbackUrl
      ? startPendingApprovalPromptWatcher({
        conversationId,
        sourceChannel,
        externalChatId,
        replyCallbackUrl,
        bearerToken,
        assistantId,
        approvalCopyGenerator,
      })
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
          isInteractive: guardianCtx.actorRole === 'guardian',
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
          {
            onSegmentDelivered: (count) =>
              channelDeliveryStore.updateDeliveredSegmentCount(eventId, count),
          },
        );
      }
    } catch (err) {
      log.error({ err, conversationId }, 'Background channel message processing failed');
      channelDeliveryStore.recordProcessingFailure(eventId, err);
    } finally {
      stopTypingHeartbeat?.();
      stopApprovalWatcher?.();
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
