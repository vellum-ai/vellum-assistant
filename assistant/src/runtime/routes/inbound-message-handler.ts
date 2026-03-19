/**
 * Channel inbound message handler: validates, records, and routes inbound
 * messages from all channels. Handles ingress ACL, edits, guardian
 * verification, guardian action answers, approval interception, and
 * invite token redemption.
 */
import { getChannelPermissionProfile } from "../../channels/permission-profiles.js";
import {
  CHANNEL_IDS,
  INTERFACE_IDS,
  isChannelId,
  parseInterfaceId,
} from "../../channels/types.js";
import { touchContactInteraction } from "../../contacts/contacts-write.js";
import type { TrustContext } from "../../daemon/conversation-runtime-assembly.js";
import * as attachmentsStore from "../../memory/attachments-store.js";
import {
  recordConversationSeenSignal,
  type SignalType,
} from "../../memory/conversation-attention-store.js";
import * as deliveryChannels from "../../memory/delivery-channels.js";
import * as deliveryCrud from "../../memory/delivery-crud.js";
import * as externalConversationStore from "../../memory/external-conversation-store.js";
import { canonicalizeInboundIdentity } from "../../util/canonicalize-identity.js";
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { mintDaemonDeliveryToken } from "../auth/token-service.js";
import { deliverChannelReply } from "../gateway-client.js";
import { httpError } from "../http-errors.js";
import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
  MessageProcessor,
} from "../http-types.js";
import { resolveTrustContext } from "../trust-context-resolver.js";
import { canonicalChannelAssistantId } from "./channel-route-shared.js";
import { handleApprovalInterception } from "./guardian-approval-interception.js";
import { enforceIngressAcl } from "./inbound-stages/acl-enforcement.js";
import { processChannelMessageInBackground } from "./inbound-stages/background-dispatch.js";
import { handleBootstrapIntercept } from "./inbound-stages/bootstrap-intercept.js";
import { handleEditIntercept } from "./inbound-stages/edit-intercept.js";
import { handleEscalationIntercept } from "./inbound-stages/escalation-intercept.js";
import { handleGuardianReplyIntercept } from "./inbound-stages/guardian-reply-intercept.js";
import { runSecretIngressCheck } from "./inbound-stages/secret-ingress-check.js";
import { tryTranscribeAudioAttachments } from "./inbound-stages/transcribe-audio.js";
import { handleVerificationIntercept } from "./inbound-stages/verification-intercept.js";

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

  let trimmedContent = typeof content === "string" ? content.trim() : "";
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
  // channels (voice, whatsapp) are normalized to E.164; non-phone
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

  // Auto-transcribe audio attachments from channel messages
  if (hasAttachments && sourceChannel) {
    const transcribeResult = await tryTranscribeAudioAttachments(attachmentIds);
    switch (transcribeResult.status) {
      case "transcribed":
        // For voice-only messages (empty content), this becomes the message text.
        // For audio+caption, both are preserved.
        trimmedContent =
          transcribeResult.text +
          (trimmedContent ? `\n\n${trimmedContent}` : "");
        break;
      case "no_provider":
      case "error":
        // Inject a hint so the assistant knows the user sent audio and why
        // transcription failed — it can then guide the user (e.g. set up API key).
        trimmedContent =
          `[Voice message received — ${transcribeResult.reason}]` +
          (trimmedContent ? `\n\n${trimmedContent}` : "");
        break;
      // "no_audio", "disabled" — no action needed
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
    return handleEditIntercept({
      sourceChannel,
      conversationExternalId,
      externalMessageId,
      sourceMessageId,
      canonicalAssistantId,
      assistantId,
      content,
      channelId: resolvedMember?.channel.id,
    });
  }

  // ── New message path ──
  const result = deliveryCrud.recordInbound(
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
    const pendingReply = deliveryChannels.getPendingVerificationReply(
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
        deliveryChannels.clearPendingVerificationReply(result.eventId);
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

  // Track contact interaction only for genuinely new messages (not webhook
  // retries). This was previously in ACL enforcement which runs before dedup,
  // causing retries to inflate interaction counts.
  if (!result.duplicate && resolvedMember) {
    touchContactInteraction(resolvedMember.channel.id);
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
  const escalationResponse = handleEscalationIntercept({
    resolvedMember,
    canonicalAssistantId,
    sourceChannel,
    sourceInterface,
    conversationExternalId,
    externalMessageId,
    conversationId: result.conversationId,
    eventId: result.eventId,
    content,
    attachmentIds,
    sourceMetadata: body.sourceMetadata,
    actorDisplayName: body.actorDisplayName,
    actorExternalId: body.actorExternalId,
    actorUsername: body.actorUsername,
    replyCallbackUrl: body.replyCallbackUrl,
    canonicalSenderId,
    rawSenderId,
  });
  if (escalationResponse) return escalationResponse;

  const metadataHintsRaw = sourceMetadata?.hints;
  const metadataHints = Array.isArray(metadataHintsRaw)
    ? metadataHintsRaw.filter(
        (hint): hint is string =>
          typeof hint === "string" && hint.trim().length > 0,
      )
    : [];

  // Inject channel-scoped permission hints for Slack channel messages
  if (sourceChannel === "slack") {
    const channelProfile = getChannelPermissionProfile(conversationExternalId);
    if (channelProfile) {
      if (channelProfile.blockedTools?.length) {
        metadataHints.push(
          `Channel policy: the following tools are blocked in this channel: ${channelProfile.blockedTools.join(", ")}`,
        );
      }
      if (channelProfile.allowedToolCategories?.length) {
        metadataHints.push(
          `Channel policy: only these tool categories are allowed in this channel: ${channelProfile.allowedToolCategories.join(", ")}`,
        );
      }
      if (channelProfile.trustLevel === "restricted") {
        metadataHints.push(
          "Channel policy: this channel has restricted trust level. Exercise caution with tool usage.",
        );
      }
    }
  }

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

  // Extract chat type (e.g. "private", "group", "supergroup") for group chat gating
  const sourceChatType =
    typeof sourceMetadata?.chatType === "string" &&
    sourceMetadata.chatType.trim().length > 0
      ? sourceMetadata.chatType.trim()
      : undefined;

  // Preserve locale from sourceMetadata so the model can greet in the user's language
  const sourceLanguageCode =
    typeof sourceMetadata?.languageCode === "string" &&
    sourceMetadata.languageCode.trim().length > 0
      ? sourceMetadata.languageCode.trim()
      : undefined;

  // ── Telegram bootstrap deep-link handling ──
  const bootstrapResponse = await handleBootstrapIntercept({
    isDuplicate: result.duplicate,
    commandIntent,
    rawSenderId,
    canonicalAssistantId,
    sourceChannel,
    conversationExternalId,
    eventId: result.eventId,
  });
  if (bootstrapResponse) return bootstrapResponse;

  // ── Guardian verification code intercept (deterministic) ──
  const verificationResponse = await handleVerificationIntercept({
    isDuplicate: result.duplicate,
    guardianVerifyCode,
    rawSenderId,
    canonicalSenderId,
    canonicalAssistantId,
    sourceChannel,
    conversationExternalId,
    conversationId: result.conversationId,
    eventId: result.eventId,
    replyCallbackUrl,
    mintBearerToken,
    assistantId,
    actorDisplayName: body.actorDisplayName,
    actorUsername: body.actorUsername,
  });
  if (verificationResponse) return verificationResponse;

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

  // ── Canonical guardian reply router ──
  const guardianReplyResult = await handleGuardianReplyIntercept({
    isDuplicate: result.duplicate,
    trimmedContent,
    hasCallbackData,
    callbackData: body.callbackData,
    rawSenderId,
    canonicalSenderId,
    canonicalAssistantId,
    sourceChannel,
    conversationExternalId,
    conversationId: result.conversationId,
    eventId: result.eventId,
    replyCallbackUrl,
    mintBearerToken,
    trustClass: trustCtx.trustClass,
    guardianPrincipalId: trustCtx.guardianPrincipalId,
    approvalConversationGenerator,
  });
  if (guardianReplyResult.response) return guardianReplyResult.response;

  // ── Approval interception ──
  // Keep this active whenever callback context is available.
  // Skipped when the canonical router flagged skipApprovalInterception (e.g.
  // invite handoff bypass) to prevent the legacy interceptor from swallowing
  // messages that should reach the assistant.
  if (
    replyCallbackUrl &&
    !result.duplicate &&
    !guardianReplyResult.skipApprovalInterception
  ) {
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
      // Record inferred seen signal for handled approval interactions
      if (sourceChannel === "telegram" || sourceChannel === "slack") {
        try {
          if (hasCallbackData) {
            const cbPreview =
              body.callbackData!.length > 80
                ? body.callbackData!.slice(0, 80) + "..."
                : body.callbackData!;
            recordConversationSeenSignal({
              conversationId: result.conversationId,
              signalType: `${sourceChannel}_callback` as SignalType,
              confidence: "inferred",
              sourceChannel,
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
              signalType: `${sourceChannel}_inbound_message` as SignalType,
              confidence: "inferred",
              sourceChannel,
              source: "inbound-message-handler",
              evidenceText: `User sent plain-text approval reply: '${msgPreview}'`,
            });
          }
        } catch (err) {
          log.warn(
            { err, conversationId: result.conversationId },
            "Failed to record seen signal for approval interaction",
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
      if (sourceChannel === "telegram" || sourceChannel === "slack") {
        try {
          const cbPreview =
            body.callbackData!.length > 80
              ? body.callbackData!.slice(0, 80) + "..."
              : body.callbackData!;
          recordConversationSeenSignal({
            conversationId: result.conversationId,
            signalType: `${sourceChannel}_callback` as SignalType,
            confidence: "inferred",
            sourceChannel,
            source: "inbound-message-handler",
            evidenceText: `User tapped stale callback: '${cbPreview}'`,
          });
        } catch (err) {
          log.warn(
            { err, conversationId: result.conversationId },
            "Failed to record seen signal for stale callback",
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
    runSecretIngressCheck({
      eventId: result.eventId,
      sourceChannel,
      conversationExternalId,
      externalMessageId,
      conversationId: result.conversationId,
      content,
      trimmedContent,
      attachmentIds,
      sourceMetadata: body.sourceMetadata,
      actorDisplayName: body.actorDisplayName,
      actorExternalId: body.actorExternalId,
      actorUsername: body.actorUsername,
      trustCtx,
      replyCallbackUrl,
      canonicalAssistantId,
    });

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
      externalMessageId: sourceMessageId ?? externalMessageId,
      chatType: sourceChatType,
    });
  }

  return Response.json({
    accepted: result.accepted,
    duplicate: result.duplicate,
    eventId: result.eventId,
  });
}
