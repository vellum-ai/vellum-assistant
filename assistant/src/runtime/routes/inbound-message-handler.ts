/**
 * Channel inbound message handler: validates, records, and routes inbound
 * messages from all channels. Handles ingress ACL, edits, guardian
 * verification, guardian action answers, approval interception, and
 * invite token redemption.
 */
// Side-effect imports: register channel invite transport adapters so the
// ACL enforcement module can resolve transports at runtime.
import type { ChannelId, InterfaceId } from "../../channels/types.js";
import {
  CHANNEL_IDS,
  INTERFACE_IDS,
  isChannelId,
  parseInterfaceId,
} from "../../channels/types.js";
import { getGatewayInternalBaseUrl } from "../../config/env.js";
import { resolveUserReference } from "../../config/user-reference.js";
import { findContactChannel } from "../../contacts/contact-store.js";
import { upsertMemberContactsFirst } from "../../contacts/contacts-write.js";
import { contactChannelToMemberRecord } from "../../contacts/member-record-shim.js";
import { RESEND_COOLDOWN_MS } from "../../daemon/handlers/config-channels.js";
import type { TrustContext } from "../../daemon/session-runtime-assembly.js";
import * as attachmentsStore from "../../memory/attachments-store.js";
import {
  createCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
  listPendingCanonicalGuardianRequestsByDestinationChat,
} from "../../memory/canonical-guardian-store.js";
import * as channelDeliveryStore from "../../memory/channel-delivery-store.js";
import { recordConversationSeenSignal } from "../../memory/conversation-attention-store.js";
import * as conversationStore from "../../memory/conversation-store.js";
import * as externalConversationStore from "../../memory/external-conversation-store.js";
import { emitNotificationSignal } from "../../notifications/emit-signal.js";
import { checkIngressForSecrets } from "../../security/secret-ingress.js";
import { canonicalizeInboundIdentity } from "../../util/canonicalize-identity.js";
import { IngressBlockedError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { mintDaemonDeliveryToken } from "../auth/token-service.js";
import {
  buildApprovalUIMetadata,
  getApprovalInfoByConversation,
  getChannelApprovalPrompt,
} from "../channel-approvals.js";
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
} from "../channel-guardian-service.js";
import { deliverChannelReply } from "../gateway-client.js";
import { routeGuardianReply } from "../guardian-reply-router.js";
import {
  composeChannelVerifyReply,
  composeVerificationTelegram,
  GUARDIAN_VERIFY_TEMPLATE_KEYS,
} from "../guardian-verification-templates.js";
import { httpError } from "../http-errors.js";
import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
  MessageProcessor,
} from "../http-types.js";
import {
  resolveRoutingState,
  resolveTrustContext,
} from "../trust-context-resolver.js";
import { deliverReplyViaCallback } from "./channel-delivery-routes.js";
import {
  canonicalChannelAssistantId,
  GUARDIAN_APPROVAL_TTL_MS,
  stripVerificationFailurePrefix,
} from "./channel-route-shared.js";
import { handleApprovalInterception } from "./guardian-approval-interception.js";
import { deliverGeneratedApprovalPrompt } from "./guardian-approval-prompt.js";
import { enforceIngressAcl } from "./inbound-stages/acl-enforcement.js";

import "../channel-invite-transports/telegram.js";
import "../channel-invite-transports/voice.js";

const log = getLogger("runtime-http");

export async function handleChannelInbound(
  req: Request,
  processMessage?: MessageProcessor,
  assistantId: string = DAEMON_INTERNAL_ASSISTANT_ID,
  approvalCopyGenerator?: ApprovalCopyGenerator,
  approvalConversationGenerator?: ApprovalConversationGenerator,
  _guardianActionCopyGenerator?: GuardianActionCopyGenerator,
  _guardianFollowUpConversationGenerator?: GuardianFollowUpConversationGenerator,
): Promise<Response> {
  // Gateway-origin proof is enforced by route-policy middleware (svc_gateway
  // principal type required) before this handler runs. The exchange JWT
  // itself proves gateway origin.

  // Factory that mints a fresh short-lived JWT for each daemon-to-gateway
  // delivery callback. The JWT has a 60-second TTL, so long-running
  // background operations (typing heartbeats, approval watchers, reply
  // delivery) must call this at each delivery attempt rather than reusing
  // a single token from request start.
  const mintBearerToken = (): string => mintDaemonDeliveryToken();

  const body = (await req.json()) as {
    sourceChannel?: string;
    interface?: string;
    conversationExternalId?: string;
    externalMessageId?: string;
    content?: string;
    isEdit?: boolean;
    actorDisplayName?: string;
    attachmentIds?: string[];
    actorExternalId?: string;
    actorUsername?: string;
    sourceMetadata?: Record<string, unknown>;
    replyCallbackUrl?: string;
    callbackQueryId?: string;
    callbackData?: string;
  };

  const {
    conversationExternalId,
    externalMessageId,
    content,
    isEdit,
    attachmentIds,
    sourceMetadata,
  } = body;

  if (!body.sourceChannel || typeof body.sourceChannel !== "string") {
    return httpError("BAD_REQUEST", "sourceChannel is required", 400);
  }
  // Validate and narrow to canonical ChannelId at the boundary — the gateway
  // only sends well-known channel strings, so an unknown value is rejected.
  if (!isChannelId(body.sourceChannel)) {
    return httpError(
      "BAD_REQUEST",
      `Invalid sourceChannel: ${
        body.sourceChannel
      }. Valid values: ${CHANNEL_IDS.join(", ")}`,
      400,
    );
  }

  const sourceChannel = body.sourceChannel;

  if (!body.interface || typeof body.interface !== "string") {
    return httpError("BAD_REQUEST", "interface is required", 400);
  }
  const sourceInterface = parseInterfaceId(body.interface);
  if (!sourceInterface) {
    return httpError(
      "BAD_REQUEST",
      `Invalid interface: ${body.interface}. Valid values: ${INTERFACE_IDS.join(
        ", ",
      )}`,
      400,
    );
  }

  if (!conversationExternalId || typeof conversationExternalId !== "string") {
    return httpError("BAD_REQUEST", "conversationExternalId is required", 400);
  }
  if (
    !body.actorExternalId ||
    typeof body.actorExternalId !== "string" ||
    !body.actorExternalId.trim()
  ) {
    return httpError("BAD_REQUEST", "actorExternalId is required", 400);
  }
  if (!externalMessageId || typeof externalMessageId !== "string") {
    return httpError("BAD_REQUEST", "externalMessageId is required", 400);
  }

  // Reject non-string content regardless of whether attachments are present.
  if (content != null && typeof content !== "string") {
    return httpError("BAD_REQUEST", "content must be a string", 400);
  }

  const trimmedContent = typeof content === "string" ? content.trim() : "";
  const hasAttachments =
    Array.isArray(attachmentIds) && attachmentIds.length > 0;

  const hasCallbackData =
    typeof body.callbackData === "string" && body.callbackData.length > 0;

  if (
    trimmedContent.length === 0 &&
    !hasAttachments &&
    !isEdit &&
    !hasCallbackData
  ) {
    return httpError(
      "BAD_REQUEST",
      "content or attachmentIds is required",
      400,
    );
  }

  // Canonicalize the assistant ID so all DB-facing operations use the
  // consistent 'self' key regardless of what the gateway sent.
  const canonicalAssistantId = canonicalChannelAssistantId(assistantId);
  if (canonicalAssistantId !== assistantId) {
    log.debug(
      { raw: assistantId, canonical: canonicalAssistantId },
      "Canonicalized channel assistant ID",
    );
  }

  // Coerce actorExternalId to a string at the boundary — the field
  // comes from unvalidated JSON and may be a number, object, or other
  // non-string type. Non-string truthy values would throw inside
  // canonicalizeInboundIdentity when it calls .trim().
  const rawSenderId =
    body.actorExternalId != null ? String(body.actorExternalId) : undefined;

  // Canonicalize the sender identity so all trust lookups, member matching,
  // and guardian binding comparisons use a normalized form. Phone-like
  // channels (sms, voice, whatsapp) are normalized to E.164; non-phone
  // channels pass through the platform-stable ID unchanged.
  const canonicalSenderId = rawSenderId
    ? canonicalizeInboundIdentity(sourceChannel, rawSenderId)
    : null;

  // Track whether the original payload included a sender identity. A
  // whitespace-only actorExternalId canonicalizes to null but still
  // represents an explicit (malformed) identity claim that must enter the
  // ACL deny path rather than bypassing it.
  const hasSenderIdentityClaim = rawSenderId !== undefined;

  // ── Ingress ACL enforcement ──
  const aclResult = await enforceIngressAcl({
    canonicalSenderId,
    hasSenderIdentityClaim,
    rawSenderId,
    sourceChannel,
    conversationExternalId,
    canonicalAssistantId,
    trimmedContent,
    sourceMetadata: body.sourceMetadata,
    actorDisplayName: body.actorDisplayName,
    actorUsername: body.actorUsername,
    replyCallbackUrl: body.replyCallbackUrl,
    mintBearerToken,
    assistantId,
    externalMessageId,
  });
  if (aclResult.earlyResponse) return aclResult.earlyResponse;
  const { resolvedMember, guardianVerifyCode } = aclResult;

  if (hasAttachments) {
    const resolved = attachmentsStore.getAttachmentsByIds(attachmentIds);
    if (resolved.length !== attachmentIds.length) {
      const resolvedIds = new Set(resolved.map((a) => a.id));
      const missing = attachmentIds.filter((id) => !resolvedIds.has(id));
      return Response.json(
        { error: `Attachment IDs not found: ${missing.join(", ")}` },
        { status: 400 },
      );
    }
  }

  const sourceMessageId =
    typeof sourceMetadata?.messageId === "string"
      ? sourceMetadata.messageId
      : undefined;

  if (isEdit && !sourceMessageId) {
    return httpError(
      "BAD_REQUEST",
      "sourceMetadata.messageId is required for edits",
      400,
    );
  }

  // ── Edit path: update existing message content, no new agent loop ──
  if (isEdit && sourceMessageId) {
    // Dedup the edit event itself (retried edited_message webhooks)
    const editResult = channelDeliveryStore.recordInbound(
      sourceChannel,
      conversationExternalId,
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
        conversationExternalId,
        sourceMessageId,
      );
      if (original) break;
      if (attempt < EDIT_LOOKUP_RETRIES) {
        log.info(
          {
            assistantId,
            sourceMessageId,
            attempt: attempt + 1,
            maxAttempts: EDIT_LOOKUP_RETRIES,
          },
          "Original message not linked yet, retrying edit lookup",
        );
        await new Promise((resolve) =>
          setTimeout(resolve, EDIT_LOOKUP_DELAY_MS),
        );
      }
    }

    if (original) {
      conversationStore.updateMessageContent(original.messageId, content ?? "");
      log.info(
        { assistantId, sourceMessageId, messageId: original.messageId },
        "Updated message content from edited_message",
      );
    } else {
      log.warn(
        { assistantId, sourceChannel, conversationExternalId, sourceMessageId },
        "Could not find original message for edit after retries, ignoring",
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
    conversationExternalId,
    externalMessageId,
    { sourceMessageId, assistantId: canonicalAssistantId },
  );

  const replyCallbackUrl = body.replyCallbackUrl;

  // ── Retry pending verification reply on duplicate ──
  // If a previous verification delivery failed and stored a pending reply,
  // gateway retries (duplicates) re-attempt delivery here. On success the
  // pending marker is cleared so further duplicates short-circuit normally.
  if (result.duplicate && replyCallbackUrl) {
    const pendingReply = channelDeliveryStore.getPendingVerificationReply(
      result.eventId,
    );
    if (pendingReply) {
      try {
        await deliverChannelReply(
          replyCallbackUrl,
          {
            chatId: pendingReply.chatId,
            text: pendingReply.text,
            assistantId: pendingReply.assistantId,
          },
          mintBearerToken(),
        );
        channelDeliveryStore.clearPendingVerificationReply(result.eventId);
        log.info(
          { eventId: result.eventId },
          "Retried pending verification reply: delivered",
        );
      } catch (retryErr) {
        log.error(
          { err: retryErr, eventId: result.eventId },
          "Retry of pending verification reply failed; will retry on next duplicate",
        );
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
  if (canonicalAssistantId === DAEMON_INTERNAL_ASSISTANT_ID) {
    externalConversationStore.upsertBinding({
      conversationId: result.conversationId,
      sourceChannel,
      externalChatId: conversationExternalId,
      externalUserId: canonicalSenderId ?? rawSenderId ?? null,
      displayName: body.actorDisplayName ?? null,
      username: body.actorUsername ?? null,
    });
  }

  // ── Ingress escalation ──
  // When the member's policy is 'escalate', create a pending guardian
  // approval request and halt the run. This check runs after recordInbound
  // so we have a conversationId for the approval record.
  if (resolvedMember?.policy === "escalate") {
    const binding = getGuardianBinding(canonicalAssistantId, sourceChannel);
    if (!binding) {
      // Fail-closed: can't escalate without a guardian to route to
      log.info(
        { sourceChannel, memberId: resolvedMember.id },
        "Ingress ACL: escalate policy but no guardian binding, denying",
      );
      return Response.json({
        accepted: true,
        denied: true,
        reason: "escalate_no_guardian",
      });
    }

    // Persist the raw payload so the decide handler can recover the original
    // message content when the escalation is approved.
    channelDeliveryStore.storePayload(result.eventId, {
      sourceChannel,
      interface: sourceInterface,
      externalChatId: conversationExternalId,
      externalMessageId,
      content,
      attachmentIds,
      sourceMetadata: body.sourceMetadata,
      senderName: body.actorDisplayName,
      senderExternalUserId: body.actorExternalId,
      senderUsername: body.actorUsername,
      replyCallbackUrl: body.replyCallbackUrl,
      assistantId: canonicalAssistantId,
    });

    try {
      createCanonicalGuardianRequest({
        kind: "tool_approval",
        sourceType: "channel",
        sourceChannel,
        conversationId: result.conversationId,
        requesterExternalUserId: canonicalSenderId ?? rawSenderId ?? undefined,
        guardianExternalUserId: binding.guardianExternalUserId,
        guardianPrincipalId: binding.guardianPrincipalId,
        toolName: "ingress_message",
        questionText: "Ingress policy requires guardian approval",
        expiresAt: new Date(
          Date.now() + GUARDIAN_APPROVAL_TTL_MS,
        ).toISOString(),
      });
    } catch (err) {
      log.warn(
        { err, conversationId: result.conversationId, sourceChannel },
        "Failed to create canonical guardian request for ingress escalation — escalation continues via notification pipeline",
      );
    }

    // Emit notification signal through the unified pipeline (fire-and-forget).
    // This lets the decision engine route escalation alerts to all configured
    // channels, supplementing the direct guardian notification below.
    void emitNotificationSignal({
      sourceEventName: "ingress.escalation",
      sourceChannel: sourceChannel,
      sourceSessionId: result.conversationId,
      assistantId: canonicalAssistantId,
      attentionHints: {
        requiresAction: true,
        urgency: "high",
        isAsyncBackground: false,
        visibleInSourceNow: false,
      },
      contextPayload: {
        conversationId: result.conversationId,
        sourceChannel,
        conversationExternalId,
        senderIdentifier:
          body.actorDisplayName ||
          body.actorUsername ||
          rawSenderId ||
          "Unknown sender",
        eventId: result.eventId,
      },
      dedupeKey: `escalation:${result.eventId}`,
    });

    // Guardian escalation channel delivery is handled by the notification
    // pipeline — no legacy callback dispatch needed.
    log.info(
      { conversationId: result.conversationId },
      "Guardian escalation created — notification pipeline handles channel delivery",
    );

    return Response.json({
      accepted: true,
      escalated: true,
      reason: "policy_escalate",
    });
  }

  const metadataHintsRaw = sourceMetadata?.hints;
  const metadataHints = Array.isArray(metadataHintsRaw)
    ? metadataHintsRaw.filter(
        (hint): hint is string =>
          typeof hint === "string" && hint.trim().length > 0,
      )
    : [];
  const metadataUxBrief =
    typeof sourceMetadata?.uxBrief === "string" &&
    sourceMetadata.uxBrief.trim().length > 0
      ? sourceMetadata.uxBrief.trim()
      : undefined;

  // Extract channel command intent (e.g. /start from Telegram)
  const rawCommandIntent = sourceMetadata?.commandIntent;
  const commandIntent =
    rawCommandIntent &&
    typeof rawCommandIntent === "object" &&
    !Array.isArray(rawCommandIntent)
      ? (rawCommandIntent as Record<string, unknown>)
      : undefined;

  // Preserve locale from sourceMetadata so the model can greet in the user's language
  const sourceLanguageCode =
    typeof sourceMetadata?.languageCode === "string" &&
    sourceMetadata.languageCode.trim().length > 0
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
    commandIntent?.type === "start" &&
    typeof commandIntent.payload === "string" &&
    (commandIntent.payload as string).startsWith("gv_") &&
    rawSenderId
  ) {
    const bootstrapToken = (commandIntent.payload as string).slice(3);
    const bootstrapSession = resolveBootstrapToken(
      canonicalAssistantId,
      sourceChannel,
      bootstrapToken,
    );

    if (bootstrapSession && bootstrapSession.status === "pending_bootstrap") {
      // Bind the pending_bootstrap session to the sender's identity
      bindSessionIdentity(
        bootstrapSession.id,
        rawSenderId!,
        conversationExternalId,
      );

      // Transition bootstrap session to awaiting_response
      updateSessionStatus(bootstrapSession.id, "awaiting_response");

      // Create a new identity-bound outbound session with a fresh secret.
      // The old bootstrap session is auto-revoked by createOutboundSession.
      const newSession = createOutboundSession({
        assistantId: canonicalAssistantId,
        channel: sourceChannel,
        expectedExternalUserId: rawSenderId!,
        expectedChatId: conversationExternalId,
        identityBindingStatus: "bound",
        destinationAddress: conversationExternalId,
      });

      // Compose and send the verification prompt via Telegram
      const telegramBody = composeVerificationTelegram(
        GUARDIAN_VERIFY_TEMPLATE_KEYS.TELEGRAM_CHALLENGE_REQUEST,
        {
          code: newSession.secret,
          expiresInMinutes: Math.floor(
            (newSession.expiresAt - Date.now()) / 60_000,
          ),
        },
      );

      // Deliver verification Telegram message via the gateway (fire-and-forget)
      deliverBootstrapVerificationTelegram(
        conversationExternalId,
        telegramBody,
        canonicalAssistantId,
      );

      // Update delivery tracking
      const now = Date.now();
      updateSessionDelivery(
        newSession.sessionId,
        now,
        1,
        now + RESEND_COOLDOWN_MS,
      );

      return Response.json({
        accepted: true,
        duplicate: false,
        eventId: result.eventId,
        guardianVerification: "bootstrap_bound",
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
  const shouldInterceptVerification =
    guardianVerifyCode !== undefined &&
    (!!getPendingChallenge(canonicalAssistantId, sourceChannel) ||
      !!findActiveSession(canonicalAssistantId, sourceChannel));

  if (
    !result.duplicate &&
    shouldInterceptVerification &&
    guardianVerifyCode !== undefined &&
    rawSenderId
  ) {
    const verifyResult = validateAndConsumeChallenge(
      canonicalAssistantId,
      sourceChannel,
      guardianVerifyCode,
      canonicalSenderId ?? rawSenderId!,
      conversationExternalId,
      body.actorUsername,
      body.actorDisplayName,
    );

    const guardianVerifyOutcome: "verified" | "failed" = verifyResult.success
      ? "verified"
      : "failed";

    if (verifyResult.success) {
      const existingContactResult =
        (canonicalSenderId ?? rawSenderId)
          ? findContactChannel({
              channelType: sourceChannel,
              externalUserId: canonicalSenderId ?? rawSenderId!,
              externalChatId: conversationExternalId,
            })
          : null;
      const existingMember = existingContactResult
        ? contactChannelToMemberRecord(
            existingContactResult.contact,
            existingContactResult.channel,
          )
        : null;
      const memberMatchesSender = existingMember?.externalUserId
        ? canonicalizeInboundIdentity(
            sourceChannel,
            existingMember.externalUserId,
          ) === (canonicalSenderId ?? rawSenderId)
        : false;
      const preservedDisplayName =
        memberMatchesSender && existingMember?.displayName?.trim().length
          ? existingMember.displayName
          : body.actorDisplayName;

      upsertMemberContactsFirst({
        assistantId: canonicalAssistantId,
        sourceChannel,
        externalUserId: canonicalSenderId ?? rawSenderId!,
        externalChatId: conversationExternalId,
        status: "active",
        policy: "allow",
        // Keep guardian-curated member name stable across re-verification.
        displayName: preservedDisplayName,
        username: body.actorUsername,
      });

      const verifyLogLabel =
        verifyResult.verificationType === "trusted_contact"
          ? "Trusted contact verified"
          : "Guardian verified";
      log.info(
        {
          sourceChannel,
          externalUserId: canonicalSenderId,
          verificationType: verifyResult.verificationType,
        },
        `${verifyLogLabel}: auto-upserted ingress member`,
      );

      // Emit activated signal when a trusted contact completes verification.
      // Member record is persisted above before this event fires, satisfying
      // the persistence-before-event ordering invariant.
      if (verifyResult.verificationType === "trusted_contact") {
        void emitNotificationSignal({
          sourceEventName: "ingress.trusted_contact.activated",
          sourceChannel,
          sourceSessionId: result.conversationId,
          assistantId: canonicalAssistantId,
          attentionHints: {
            requiresAction: false,
            urgency: "low",
            isAsyncBackground: false,
            visibleInSourceNow: false,
          },
          contextPayload: {
            sourceChannel,
            actorExternalId: canonicalSenderId ?? rawSenderId!,
            conversationExternalId,
            actorDisplayName: body.actorDisplayName ?? null,
            actorUsername: body.actorUsername ?? null,
          },
          dedupeKey: `trusted-contact:activated:${canonicalAssistantId}:${sourceChannel}:${
            canonicalSenderId ?? rawSenderId!
          }`,
        });
      }
    }

    // Deliver a deterministic template-driven reply and short-circuit.
    // Verification code messages must never produce agent-generated copy.
    if (replyCallbackUrl) {
      let replyText: string;
      if (!verifyResult.success) {
        replyText = composeChannelVerifyReply(
          GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_FAILED,
          {
            failureReason: stripVerificationFailurePrefix(verifyResult.reason),
          },
        );
      } else if (verifyResult.verificationType === "trusted_contact") {
        replyText = composeChannelVerifyReply(
          GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_TRUSTED_CONTACT_VERIFY_SUCCESS,
        );
      } else {
        replyText = composeChannelVerifyReply(
          GUARDIAN_VERIFY_TEMPLATE_KEYS.CHANNEL_VERIFY_SUCCESS,
        );
      }
      try {
        await deliverChannelReply(
          replyCallbackUrl,
          {
            chatId: conversationExternalId,
            text: replyText,
            assistantId,
          },
          mintBearerToken(),
        );
      } catch (err) {
        // The challenge is already consumed and side effects applied, so
        // we cannot simply re-throw and let the gateway retry the full
        // flow. Instead, persist the reply so that gateway retries
        // (which arrive as duplicates) can re-attempt delivery.
        log.error(
          { err, conversationExternalId },
          "Failed to deliver deterministic verification reply; persisting for retry",
        );
        channelDeliveryStore.storePendingVerificationReply(result.eventId, {
          chatId: conversationExternalId,
          text: replyText,
          assistantId,
        });

        // Self-retry after a short delay. The gateway deduplicates
        // inbound webhooks after a successful forward, so duplicate
        // retries may never arrive. This fire-and-forget retry ensures
        // delivery is re-attempted even without a gateway duplicate.
        setTimeout(async () => {
          try {
            await deliverChannelReply(
              replyCallbackUrl,
              {
                chatId: conversationExternalId,
                text: replyText,
                assistantId,
              },
              mintBearerToken(),
            );
            log.info(
              { eventId: result.eventId },
              "Verification reply delivered on self-retry",
            );
            channelDeliveryStore.clearPendingVerificationReply(result.eventId);
          } catch (retryErr) {
            log.error(
              { err: retryErr, eventId: result.eventId },
              "Verification reply self-retry also failed; pending reply remains as fallback",
            );
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
  const trustCtx: TrustContext = resolveTrustContext({
    assistantId: canonicalAssistantId,
    sourceChannel,
    conversationExternalId,
    actorExternalId: rawSenderId,
    actorUsername: body.actorUsername,
    actorDisplayName: body.actorDisplayName,
  });

  // Hoisted flag: set by the canonical guardian reply router when the invite
  // handoff bypass fires. Prevents legacy approval interception from swallowing
  // the message when other approvals are pending in the same chat.
  let skipApprovalInterception = false;

  // ── Canonical guardian reply router ──
  // Attempts to route inbound messages through the canonical decision pipeline
  // before falling through to the legacy approval interception. Handles
  // deterministic callbacks (button presses), request code prefixes, and
  // NL classification via the conversational approval engine.
  if (
    !result.duplicate &&
    replyCallbackUrl &&
    (trimmedContent.length > 0 || hasCallbackData) &&
    rawSenderId &&
    trustCtx.trustClass === "guardian"
  ) {
    // Compute destination-scoped pending request hints so the router can
    // discover canonical requests delivered to this chat even when the
    // request lacks a guardianExternalUserId (e.g. voice-originated
    // pending_question requests).
    //
    // When delivery-scoped matches exist, union them with any identity-
    // based pending requests so that requests without delivery rows (e.g.
    // tool_approval requests created inline) are not silently excluded.
    // Pass undefined (not []) when there are zero combined results so the
    // router's own identity-based fallback stays active.
    const deliveryScopedPendingRequests =
      listPendingCanonicalGuardianRequestsByDestinationChat(
        sourceChannel,
        conversationExternalId,
      );
    let pendingRequestIds: string[] | undefined;
    if (deliveryScopedPendingRequests.length > 0) {
      const deliveryIds = new Set(
        deliveryScopedPendingRequests.map((r) => r.id),
      );
      // Also include identity-based pending requests so we don't hide them
      const identityId = canonicalSenderId ?? rawSenderId!;
      const identityPending = listCanonicalGuardianRequests({
        status: "pending",
        guardianExternalUserId: identityId,
      });
      for (const r of identityPending) {
        deliveryIds.add(r.id);
      }
      pendingRequestIds = [...deliveryIds];
    }

    const routerResult = await routeGuardianReply({
      messageText: trimmedContent,
      channel: sourceChannel,
      actor: {
        externalUserId: canonicalSenderId ?? rawSenderId!,
        channel: sourceChannel,
        guardianPrincipalId: trustCtx.guardianPrincipalId ?? undefined,
      },
      conversationId: result.conversationId,
      callbackData: body.callbackData,
      pendingRequestIds,
      approvalConversationGenerator,
      channelDeliveryContext: {
        replyCallbackUrl,
        guardianChatId: conversationExternalId,
        assistantId: canonicalAssistantId,
        bearerToken: mintBearerToken(),
      },
    });

    if (routerResult.consumed) {
      // Deliver reply text if the router produced one
      if (routerResult.replyText) {
        try {
          await deliverChannelReply(
            replyCallbackUrl,
            {
              chatId: conversationExternalId,
              text: routerResult.replyText,
              assistantId: canonicalAssistantId,
            },
            mintBearerToken(),
          );
        } catch (err) {
          log.error(
            { err, conversationExternalId },
            "Failed to deliver canonical router reply",
          );
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

    if (routerResult.skipApprovalInterception) {
      skipApprovalInterception = true;
    }
  }

  // ── Approval interception ──
  // Keep this active whenever callback context is available.
  // Skipped when the canonical router flagged skipApprovalInterception (e.g.
  // invite handoff bypass) to prevent the legacy interceptor from swallowing
  // messages that should reach the assistant.
  if (replyCallbackUrl && !result.duplicate && !skipApprovalInterception) {
    const approvalResult = await handleApprovalInterception({
      conversationId: result.conversationId,
      callbackData: body.callbackData,
      content: trimmedContent,
      conversationExternalId,
      sourceChannel,
      actorExternalId: canonicalSenderId ?? rawSenderId,
      replyCallbackUrl,
      bearerToken: mintBearerToken(),
      trustCtx,
      assistantId: canonicalAssistantId,
      approvalCopyGenerator,
      approvalConversationGenerator,
    });

    if (approvalResult.handled) {
      // Record inferred seen signal for all handled Telegram approval interactions
      if (sourceChannel === "telegram") {
        try {
          if (hasCallbackData) {
            const cbPreview =
              body.callbackData!.length > 80
                ? body.callbackData!.slice(0, 80) + "..."
                : body.callbackData!;
            recordConversationSeenSignal({
              conversationId: result.conversationId,
              assistantId: canonicalAssistantId,
              signalType: "telegram_callback",
              confidence: "inferred",
              sourceChannel: "telegram",
              source: "inbound-message-handler",
              evidenceText: `User tapped callback: '${cbPreview}'`,
            });
          } else {
            const msgPreview =
              trimmedContent.length > 80
                ? trimmedContent.slice(0, 80) + "..."
                : trimmedContent;
            recordConversationSeenSignal({
              conversationId: result.conversationId,
              assistantId: canonicalAssistantId,
              signalType: "telegram_inbound_message",
              confidence: "inferred",
              sourceChannel: "telegram",
              source: "inbound-message-handler",
              evidenceText: `User sent plain-text approval reply: '${msgPreview}'`,
            });
          }
        } catch (err) {
          log.warn(
            { err, conversationId: result.conversationId },
            "Failed to record seen signal for Telegram approval interaction",
          );
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
      if (sourceChannel === "telegram") {
        try {
          const cbPreview =
            body.callbackData!.length > 80
              ? body.callbackData!.slice(0, 80) + "..."
              : body.callbackData!;
          recordConversationSeenSignal({
            conversationId: result.conversationId,
            assistantId: canonicalAssistantId,
            signalType: "telegram_callback",
            confidence: "inferred",
            sourceChannel: "telegram",
            source: "inbound-message-handler",
            evidenceText: `User tapped stale callback: '${cbPreview}'`,
          });
        } catch (err) {
          log.warn(
            { err, conversationId: result.conversationId },
            "Failed to record seen signal for stale Telegram callback",
          );
        }
      }

      return Response.json({
        accepted: true,
        duplicate: false,
        eventId: result.eventId,
        approval: "stale_ignored",
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
      sourceChannel,
      externalChatId: conversationExternalId,
      externalMessageId,
      content,
      attachmentIds,
      sourceMetadata: body.sourceMetadata,
      senderName: body.actorDisplayName,
      senderExternalUserId: body.actorExternalId,
      senderUsername: body.actorUsername,
      trustCtx,
      replyCallbackUrl,
      assistantId: canonicalAssistantId,
    });

    const contentToCheck = content ?? "";
    let ingressCheck: ReturnType<typeof checkIngressForSecrets>;
    try {
      ingressCheck = checkIngressForSecrets(contentToCheck);
    } catch (checkErr) {
      channelDeliveryStore.clearPayload(result.eventId);
      throw checkErr;
    }
    if (ingressCheck.blocked) {
      channelDeliveryStore.clearPayload(result.eventId);
      throw new IngressBlockedError(
        ingressCheck.userNotice!,
        ingressCheck.detectedTypes,
      );
    }

    // Record inferred seen signal for non-duplicate Telegram inbound messages
    if (sourceChannel === "telegram") {
      try {
        const msgPreview =
          trimmedContent.length > 80
            ? trimmedContent.slice(0, 80) + "..."
            : trimmedContent;
        const evidence =
          trimmedContent.length > 0
            ? `User sent message: '${msgPreview}'`
            : "User sent media attachment";
        recordConversationSeenSignal({
          conversationId: result.conversationId,
          assistantId: canonicalAssistantId,
          signalType: "telegram_inbound_message",
          confidence: "inferred",
          sourceChannel: "telegram",
          source: "inbound-message-handler",
          evidenceText: evidence,
        });
      } catch (err) {
        log.warn(
          { err, conversationId: result.conversationId },
          "Failed to record seen signal for Telegram inbound message",
        );
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
      content: content ?? "",
      attachmentIds: hasAttachments ? attachmentIds : undefined,
      sourceChannel,
      sourceInterface,
      externalChatId: conversationExternalId,
      trustCtx,
      metadataHints,
      metadataUxBrief,
      commandIntent,
      sourceLanguageCode,
      replyCallbackUrl,
      mintBearerToken,
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
  trustCtx: TrustContext;
  metadataHints: string[];
  metadataUxBrief?: string;
  replyCallbackUrl?: string;
  /** Factory that mints a fresh delivery JWT for each HTTP attempt. */
  mintBearerToken: () => string;
  assistantId?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
  commandIntent?: Record<string, unknown>;
  sourceLanguageCode?: string;
}

const TELEGRAM_TYPING_INTERVAL_MS = 4_000;
const PENDING_APPROVAL_POLL_INTERVAL_MS = 300;

// Module-level map tracking which approval requestIds have already been
// notified to trusted contacts. Maps requestId -> conversationId so that
// cleanup can be scoped to the owning conversation's poller, preventing
// concurrent pollers from different conversations from evicting each
// other's entries.
const globalNotifiedApprovalRequestIds = new Map<string, string>();

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function shouldEmitTelegramTyping(
  sourceChannel: ChannelId,
  replyCallbackUrl?: string,
): boolean {
  if (sourceChannel !== "telegram" || !replyCallbackUrl) return false;
  try {
    return new URL(replyCallbackUrl).pathname.endsWith("/deliver/telegram");
  } catch {
    return replyCallbackUrl.endsWith("/deliver/telegram");
  }
}

function startTelegramTypingHeartbeat(
  callbackUrl: string,
  chatId: string,
  mintBearerToken: () => string,
  assistantId?: string,
): () => void {
  let active = true;
  let inFlight = false;

  const emitTyping = (): void => {
    if (!active || inFlight) return;
    inFlight = true;
    void deliverChannelReply(
      callbackUrl,
      { chatId, chatAction: "typing", assistantId },
      mintBearerToken(),
    )
      .catch((err) => {
        log.debug(
          { err, chatId },
          "Failed to deliver Telegram typing indicator",
        );
      })
      .finally(() => {
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
  trustClass: TrustContext["trustClass"];
  guardianExternalUserId?: string;
  requesterExternalUserId?: string;
  replyCallbackUrl: string;
  mintBearerToken: () => string;
  assistantId?: string;
  approvalCopyGenerator?: ApprovalCopyGenerator;
}): () => void {
  const {
    conversationId,
    sourceChannel,
    externalChatId,
    trustClass,
    guardianExternalUserId,
    requesterExternalUserId,
    replyCallbackUrl,
    mintBearerToken,
    assistantId,
    approvalCopyGenerator,
  } = params;

  // Approval prompt delivery is guardian-only. Non-guardian and unverified
  // actors must never receive approval prompt broadcasts for the conversation.
  // We also require an explicit identity match against the bound guardian to
  // avoid broadcasting prompts when trustClass is stale/mis-scoped.
  const isBoundGuardianActor =
    trustClass === "guardian" &&
    !!guardianExternalUserId &&
    requesterExternalUserId === guardianExternalUserId;
  if (!isBoundGuardianActor) {
    return () => {};
  }

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
            assistantId: assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
            bearerToken: mintBearerToken(),
            prompt,
            uiMetadata: buildApprovalUIMetadata(prompt, info),
            messageContext: {
              scenario: "standard_prompt",
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
        log.warn(
          { err, conversationId },
          "Pending approval prompt watcher failed",
        );
      }
      await delay(PENDING_APPROVAL_POLL_INTERVAL_MS);
    }
  };

  void poll();
  return () => {
    active = false;
  };
}

/**
 * Resolve a human-readable guardian name from the guardian binding metadata.
 * Returns the display name, username (prefixed with @), or undefined if
 * no name is available.
 */
function resolveGuardianDisplayName(
  assistantId: string,
  sourceChannel: ChannelId,
): string | undefined {
  const binding = getGuardianBinding(assistantId, sourceChannel);
  if (!binding?.metadataJson) return undefined;
  try {
    const parsed = JSON.parse(binding.metadataJson) as Record<string, unknown>;
    if (
      typeof parsed.displayName === "string" &&
      parsed.displayName.trim().length > 0
    ) {
      return parsed.displayName.trim();
    }
    if (
      typeof parsed.username === "string" &&
      parsed.username.trim().length > 0
    ) {
      return `@${parsed.username.trim()}`;
    }
  } catch {
    // ignore malformed metadata
  }
  return undefined;
}

/**
 * Start a poller that sends a one-shot "waiting for guardian approval" message
 * to the trusted contact when a confirmation_request enters guardian approval
 * wait. Deduplicates by requestId so each request only produces one message.
 *
 * Only activates for trusted-contact actors with a resolvable guardian route.
 */
function startTrustedContactApprovalNotifier(params: {
  conversationId: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  trustClass: TrustContext["trustClass"];
  guardianExternalUserId?: string;
  replyCallbackUrl: string;
  mintBearerToken: () => string;
  assistantId?: string;
}): () => void {
  const {
    conversationId,
    sourceChannel,
    externalChatId,
    trustClass,
    guardianExternalUserId,
    replyCallbackUrl,
    mintBearerToken,
    assistantId,
  } = params;

  // Only notify trusted contacts who have a resolvable guardian route.
  if (trustClass !== "trusted_contact" || !guardianExternalUserId) {
    return () => {};
  }

  let active = true;

  const poll = async (): Promise<void> => {
    while (active) {
      try {
        const pending = getApprovalInfoByConversation(conversationId);
        const info = pending[0];

        // Clean up resolved requests from the module-level dedupe map.
        // Only remove entries that belong to THIS conversation — other
        // conversations' pollers own their own entries. Without this
        // scoping, concurrent pollers would evict each other's request
        // IDs and cause duplicate notifications.
        const currentPendingIds = new Set(pending.map((p) => p.requestId));
        for (const [rid, cid] of globalNotifiedApprovalRequestIds) {
          if (cid === conversationId && !currentPendingIds.has(rid)) {
            globalNotifiedApprovalRequestIds.delete(rid);
          }
        }

        if (info && !globalNotifiedApprovalRequestIds.has(info.requestId)) {
          globalNotifiedApprovalRequestIds.set(info.requestId, conversationId);
          const guardianName =
            resolveGuardianDisplayName(
              assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
              sourceChannel,
            ) ?? resolveUserReference();
          const waitingText = `Waiting for ${guardianName}'s approval...`;
          try {
            await deliverChannelReply(
              replyCallbackUrl,
              {
                chatId: externalChatId,
                text: waitingText,
                assistantId: assistantId ?? DAEMON_INTERNAL_ASSISTANT_ID,
              },
              mintBearerToken(),
            );
          } catch (err) {
            log.warn(
              { err, conversationId },
              "Failed to deliver trusted-contact pending-approval notification",
            );
            // Remove from notified set so delivery is retried on next poll
            globalNotifiedApprovalRequestIds.delete(info.requestId);
          }
        }
      } catch (err) {
        log.warn(
          { err, conversationId },
          "Trusted-contact approval notifier poll failed",
        );
      }
      await delay(PENDING_APPROVAL_POLL_INTERVAL_MS);
    }
  };

  void poll();
  return () => {
    active = false;

    // Evict all dedupe entries owned by this conversation so the
    // module-level map doesn't grow unboundedly after the poller stops.
    for (const [rid, cid] of globalNotifiedApprovalRequestIds) {
      if (cid === conversationId) {
        globalNotifiedApprovalRequestIds.delete(rid);
      }
    }
  };
}

function processChannelMessageInBackground(
  params: BackgroundProcessingParams,
): void {
  const {
    processMessage,
    conversationId,
    eventId,
    content,
    attachmentIds,
    sourceChannel,
    sourceInterface,
    externalChatId,
    trustCtx,
    metadataHints,
    metadataUxBrief,
    replyCallbackUrl,
    mintBearerToken,
    assistantId,
    approvalCopyGenerator,
    commandIntent,
    sourceLanguageCode,
  } = params;

  (async () => {
    const typingCallbackUrl = shouldEmitTelegramTyping(
      sourceChannel,
      replyCallbackUrl,
    )
      ? replyCallbackUrl
      : undefined;
    const stopTypingHeartbeat = typingCallbackUrl
      ? startTelegramTypingHeartbeat(
          typingCallbackUrl,
          externalChatId,
          mintBearerToken,
          assistantId,
        )
      : undefined;
    const stopApprovalWatcher = replyCallbackUrl
      ? startPendingApprovalPromptWatcher({
          conversationId,
          sourceChannel,
          externalChatId,
          trustClass: trustCtx.trustClass,
          guardianExternalUserId: trustCtx.guardianExternalUserId,
          requesterExternalUserId: trustCtx.requesterExternalUserId,
          replyCallbackUrl,
          mintBearerToken,
          assistantId,
          approvalCopyGenerator,
        })
      : undefined;
    const stopTcApprovalNotifier = replyCallbackUrl
      ? startTrustedContactApprovalNotifier({
          conversationId,
          sourceChannel,
          externalChatId,
          trustClass: trustCtx.trustClass,
          guardianExternalUserId: trustCtx.guardianExternalUserId,
          replyCallbackUrl,
          mintBearerToken,
          assistantId,
        })
      : undefined;

    try {
      const cmdIntent =
        commandIntent && typeof commandIntent.type === "string"
          ? {
              type: commandIntent.type as string,
              ...(typeof commandIntent.payload === "string"
                ? { payload: commandIntent.payload }
                : {}),
              ...(sourceLanguageCode
                ? { languageCode: sourceLanguageCode }
                : {}),
            }
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
          trustContext: trustCtx,
          isInteractive: resolveRoutingState(trustCtx).promptWaitingAllowed,
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
          mintBearerToken(),
          assistantId,
          {
            onSegmentDelivered: (count) =>
              channelDeliveryStore.updateDeliveredSegmentCount(eventId, count),
          },
        );
      }
    } catch (err) {
      log.error(
        { err, conversationId },
        "Background channel message processing failed",
      );
      channelDeliveryStore.recordProcessingFailure(eventId, err);
    } finally {
      stopTypingHeartbeat?.();
      stopApprovalWatcher?.();
      stopTcApprovalNotifier?.();
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
    const bearerToken = mintDaemonDeliveryToken();
    const url = `${gatewayUrl}/deliver/telegram`;
    const resp = await fetch(url, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${bearerToken}`,
      },
      body: JSON.stringify({ chatId, text, assistantId }),
    });
    if (!resp.ok) {
      const body = await resp.text().catch(() => "<unreadable>");
      log.error(
        { chatId, assistantId, status: resp.status, body },
        "Gateway /deliver/telegram failed for bootstrap verification",
      );
      return false;
    }
    return true;
  };

  (async () => {
    try {
      const delivered = await attemptDelivery();
      if (delivered) {
        log.info(
          { chatId, assistantId },
          "Bootstrap verification Telegram message delivered",
        );
        return;
      }
    } catch (err) {
      log.error(
        { err, chatId, assistantId },
        "Failed to deliver bootstrap verification Telegram message",
      );
    }

    // Self-retry after a short delay. The gateway deduplicates inbound
    // webhooks after a successful forward, so duplicate retries from the
    // user re-clicking the deep link may never arrive. This ensures
    // delivery is re-attempted even without a gateway duplicate.
    setTimeout(async () => {
      try {
        const delivered = await attemptDelivery();
        if (delivered) {
          log.info(
            { chatId, assistantId },
            "Bootstrap verification Telegram message delivered on self-retry",
          );
        } else {
          log.error(
            { chatId, assistantId },
            "Bootstrap verification Telegram self-retry also failed",
          );
        }
      } catch (retryErr) {
        log.error(
          { err: retryErr, chatId, assistantId },
          "Bootstrap verification Telegram self-retry threw; giving up",
        );
      }
    }, 3000);
  })();
}
