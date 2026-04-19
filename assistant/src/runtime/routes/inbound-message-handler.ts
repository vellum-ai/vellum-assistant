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
import type { HeartbeatService } from "../../heartbeat/heartbeat-service.js";
import * as attachmentsStore from "../../memory/attachments-store.js";
import {
  recordConversationSeenSignal,
  type SignalType,
} from "../../memory/conversation-attention-store.js";
import {
  addMessage,
  getMessageById,
  updateMessageMetadata,
} from "../../memory/conversation-crud.js";
import * as deliveryChannels from "../../memory/delivery-channels.js";
import * as deliveryCrud from "../../memory/delivery-crud.js";
import * as deliveryStatus from "../../memory/delivery-status.js";
import * as externalConversationStore from "../../memory/external-conversation-store.js";
import {
  mergeSlackMetadata,
  type SlackMessageMetadata,
  writeSlackMetadata,
} from "../../messaging/providers/slack/message-metadata.js";
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
import { handleGuardianActivationIntercept } from "./inbound-stages/guardian-activation-intercept.js";
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
  heartbeatService?: HeartbeatService,
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

  // ── Slack delete propagation ──
  // Slack message_deleted events are forwarded by the gateway with the
  // sentinel `callbackData = "message_deleted"` and `sourceMetadata.messageId`
  // set to the original (deleted) message's ts. Short-circuit the rest of
  // the pipeline: the agent loop should not run for delete notifications,
  // and routing the event through guardian/ACL/approval paths would be
  // incorrect. We mark the stored row as deleted in slackMeta but leave
  // `content` untouched for audit purposes — rendering elides based on
  // the deletedAt marker.
  if (
    sourceChannel === "slack" &&
    body.callbackData === "message_deleted"
  ) {
    const deletedMessageTs =
      typeof sourceMetadata?.messageId === "string"
        ? sourceMetadata.messageId
        : undefined;

    if (!deletedMessageTs) {
      log.debug(
        { conversationExternalId },
        "Slack message_deleted event missing sourceMetadata.messageId; ignoring",
      );
      return Response.json({ accepted: true, deleted: false });
    }

    // Look up the stored message via the existing channel-event lookup.
    // The original message's externalMessageId may differ from its ts
    // (Slack populates client_msg_id when present), so we join via the
    // sourceMessageId column which records the ts explicitly.
    const original = deliveryCrud.findMessageBySourceId(
      sourceChannel,
      conversationExternalId,
      deletedMessageTs,
    );

    if (!original) {
      log.debug(
        { conversationExternalId, deletedMessageTs },
        "No stored message found for Slack delete; ignoring",
      );
      return Response.json({ accepted: true, deleted: false });
    }

    // Merge deletedAt into the existing slackMeta sub-key. If the row has
    // no slackMeta (legacy pre-upgrade row), skip — the renderer's flat
    // fallback ignores deletedAt for those rows anyway, and synthesizing
    // a partial slackMeta here would produce metadata that fails
    // readSlackMetadata validation.
    const row = getMessageById(original.messageId);
    if (!row?.metadata) {
      log.debug(
        {
          conversationExternalId,
          deletedMessageTs,
          messageId: original.messageId,
        },
        "Stored Slack message has no metadata; skipping delete marker",
      );
      return Response.json({ accepted: true, deleted: false });
    }

    let parentMetadata: Record<string, unknown>;
    try {
      const parsed = JSON.parse(row.metadata) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        parentMetadata = parsed as Record<string, unknown>;
      } else {
        parentMetadata = {};
      }
    } catch {
      log.debug(
        {
          conversationExternalId,
          deletedMessageTs,
          messageId: original.messageId,
        },
        "Failed to parse stored metadata; skipping delete marker",
      );
      return Response.json({ accepted: true, deleted: false });
    }

    const existingSlackMeta =
      typeof parentMetadata.slackMeta === "string"
        ? parentMetadata.slackMeta
        : null;

    if (!existingSlackMeta) {
      log.debug(
        {
          conversationExternalId,
          deletedMessageTs,
          messageId: original.messageId,
        },
        "Stored Slack message has no slackMeta; skipping delete marker",
      );
      return Response.json({ accepted: true, deleted: false });
    }

    const updatedSlackMeta = mergeSlackMetadata(existingSlackMeta, {
      deletedAt: Date.now(),
    });

    // updateMessageMetadata performs a shallow merge over the parent
    // metadata, replacing only `slackMeta` and leaving sibling keys
    // (channel, interface, provenance, etc.) untouched. Content column
    // is intentionally not updated.
    updateMessageMetadata(original.messageId, { slackMeta: updatedSlackMeta });

    log.info(
      {
        conversationExternalId,
        deletedMessageTs,
        messageId: original.messageId,
      },
      "Marked Slack message as deleted",
    );

    return Response.json({
      accepted: true,
      deleted: true,
      messageId: original.messageId,
    });
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

  // ── Guardian channel activation ──
  // When a bare /start arrives on a channel with no guardian, auto-initiate
  // guardian verification so the first user can claim the channel.
  const guardianActivationResponse = await handleGuardianActivationIntercept({
    sourceChannel,
    conversationExternalId,
    rawSenderId,
    canonicalSenderId,
    actorDisplayName: body.actorDisplayName,
    actorUsername: body.actorUsername,
    sourceMetadata: body.sourceMetadata,
    replyCallbackUrl: body.replyCallbackUrl,
    mintBearerToken,
    assistantId,
    externalMessageId,
  });
  if (guardianActivationResponse) return guardianActivationResponse;

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

  // ── Slack reaction persistence ──
  // Reactions arrive as regular `SlackInboundEvent`s with `callbackData`
  // prefixed `reaction:` (added) or `reaction_removed:` (removed). Persist
  // them as `messages` rows so the chronological renderer (PR 18) can
  // surface them inline. Reactions never trigger an agent response, so we
  // short-circuit before escalation, approval interception, and agent-loop
  // dispatch.
  if (isSlackReactionEvent(body)) {
    const reactedMessageTs =
      typeof sourceMetadata?.messageId === "string"
        ? sourceMetadata.messageId
        : undefined;
    if (!reactedMessageTs) {
      log.debug(
        { conversationId: result.conversationId, eventId: result.eventId },
        "Skipping reaction persistence: missing sourceMetadata.messageId",
      );
      return Response.json({
        accepted: result.accepted,
        duplicate: result.duplicate,
        eventId: result.eventId,
      });
    }

    const threadTs =
      typeof sourceMetadata?.threadId === "string"
        ? sourceMetadata.threadId
        : undefined;

    try {
      await persistSlackReactionAsMessage({
        conversationId: result.conversationId,
        conversationExternalId,
        eventId: result.eventId,
        callbackData: body.callbackData!,
        actorDisplayName: body.actorDisplayName,
        threadTs,
        reactedMessageTs,
        duplicate: result.duplicate,
      });
    } catch (err) {
      log.error(
        { err, conversationId: result.conversationId, eventId: result.eventId },
        "Failed to persist Slack reaction event",
      );
    }

    return Response.json({
      accepted: result.accepted,
      duplicate: result.duplicate,
      eventId: result.eventId,
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
    content: trimmedContent,
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
    // Extract the original approval message timestamp for Slack button
    // cleanup. When a Slack block_actions payload is forwarded, the gateway
    // sets sourceMetadata.messageId to the ts of the message containing
    // the button. This lets us edit the message after resolution.
    const approvalMessageTs =
      sourceChannel === "slack" && typeof sourceMetadata?.messageId === "string"
        ? sourceMetadata.messageId
        : undefined;

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
      approvalMessageTs,
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

      // On Slack, edit the original approval message to remove stale buttons
      // and deliver an ephemeral error so the user gets visible feedback
      // instead of a silent no-op (JARVIS-299).
      if (sourceChannel === "slack" && replyCallbackUrl && approvalMessageTs) {
        deliverChannelReply(
          replyCallbackUrl,
          {
            chatId: conversationExternalId,
            text: "This approval request has been resolved.",
            messageTs: approvalMessageTs,
            assistantId: canonicalAssistantId,
          },
          mintBearerToken(),
        ).catch((err) => {
          log.error(
            { err, conversationId: result.conversationId },
            "Failed to edit stale Slack approval message",
          );
        });
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
    const ingressResult = runSecretIngressCheck({
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

    if (ingressResult.blocked) {
      // Intentional block — mark the event as processed (not failed/dead-lettered).
      deliveryStatus.markProcessed(result.eventId);
      log.info(
        {
          eventId: result.eventId,
          detectedTypes: ingressResult.detectedTypes,
        },
        "Channel message blocked at ingress: contains secrets",
      );
    } else {
      // Guardian messages reset the heartbeat timer so the next heartbeat
      // fires a full interval after this interaction.
      if (trustCtx.trustClass === "guardian") {
        heartbeatService?.resetTimer();
      }

      // Slack inbound metadata captured for thread-aware persistence. The
      // gateway forwards `thread_ts` under `sourceMetadata.threadId` (PR 2)
      // and the message's own ts under `sourceMetadata.messageId`. Persistence
      // turns this into a `slackMeta` sub-object in the row's metadata column
      // so the chronological renderer in later PRs can reconstruct thread
      // structure without re-fetching from Slack.
      const slackThreadTs =
        sourceChannel === "slack" &&
        typeof sourceMetadata?.threadId === "string"
          ? sourceMetadata.threadId
          : undefined;
      const slackInbound =
        sourceChannel === "slack"
          ? {
              channelId: conversationExternalId,
              channelTs: sourceMessageId ?? externalMessageId,
              ...(slackThreadTs ? { threadTs: slackThreadTs } : {}),
              ...(body.actorDisplayName ?? body.actorUsername
                ? {
                    displayName:
                      body.actorDisplayName ?? body.actorUsername!,
                  }
                : {}),
            }
          : undefined;

      // Fire-and-forget: process the message and deliver the reply in the background.
      // The HTTP response returns immediately so the gateway webhook is not blocked.
      // The onEvent callback in processMessage registers pending interactions, and
      // approval interception (above) handles decisions via the pending-interactions tracker.
      processChannelMessageInBackground({
        processMessage,
        conversationId: result.conversationId,
        eventId: result.eventId,
        content: trimmedContent,
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
        chatType: sourceChatType,
        slackInbound,
      });
    }
  }

  return Response.json({
    accepted: result.accepted,
    duplicate: result.duplicate,
    eventId: result.eventId,
  });
}

/**
 * Detect a Slack reaction event by inspecting the inbound payload's
 * `callbackData` prefix. The gateway encodes reactions as a unified
 * `SlackInboundEvent` with `callbackData` of the form
 * `reaction:<emoji>` (added) or `reaction_removed:<emoji>` (removed) —
 * see `gateway/src/slack/normalize.ts`. This helper centralizes that
 * convention so the daemon can route reactions to a dedicated persistence
 * branch instead of the agent-response pipeline.
 */
export function isSlackReactionEvent(body: {
  sourceChannel?: string;
  callbackData?: string;
}): boolean {
  if (body.sourceChannel !== "slack") return false;
  const cb = body.callbackData;
  if (typeof cb !== "string") return false;
  return cb.startsWith("reaction:") || cb.startsWith("reaction_removed:");
}

/**
 * Parse a reaction `callbackData` string into its op (added/removed) and
 * emoji name. Returns `null` when the input is not a reaction prefix or
 * when the emoji portion is empty.
 */
export function parseSlackReactionCallbackData(
  callbackData: string,
): { op: "added" | "removed"; emoji: string } | null {
  let op: "added" | "removed";
  let emoji: string;
  if (callbackData.startsWith("reaction_removed:")) {
    op = "removed";
    emoji = callbackData.slice("reaction_removed:".length);
  } else if (callbackData.startsWith("reaction:")) {
    op = "added";
    emoji = callbackData.slice("reaction:".length);
  } else {
    return null;
  }
  if (emoji.length === 0) return null;
  return { op, emoji };
}

/**
 * Persist a Slack reaction event as a `messages` row with `slackMeta`
 * envelope so the renderer can surface it inline in the chronological
 * transcript. Reactions do not trigger an agent response — the row is
 * written and the inbound event is linked, but the agent loop is not
 * dispatched.
 *
 * The caller is expected to have run `recordInbound` already so that
 * deduplication and conversation resolution have happened. Duplicate
 * inbound events are skipped here to keep persistence idempotent.
 */
async function persistSlackReactionAsMessage(params: {
  conversationId: string;
  conversationExternalId: string;
  eventId: string;
  callbackData: string;
  actorDisplayName?: string;
  threadTs?: string;
  reactedMessageTs: string;
  duplicate: boolean;
}): Promise<void> {
  if (params.duplicate) return;

  const parsed = parseSlackReactionCallbackData(params.callbackData);
  if (!parsed) {
    log.debug(
      { conversationId: params.conversationId, callbackData: params.callbackData },
      "Skipping reaction persistence: unparseable callbackData",
    );
    return;
  }

  const slackMeta: SlackMessageMetadata = {
    source: "slack",
    channelId: params.conversationExternalId,
    channelTs: params.reactedMessageTs,
    eventKind: "reaction",
    ...(params.threadTs ? { threadTs: params.threadTs } : {}),
    ...(params.actorDisplayName ? { displayName: params.actorDisplayName } : {}),
    reaction: {
      emoji: parsed.emoji,
      targetChannelTs: params.reactedMessageTs,
      op: parsed.op,
      ...(params.actorDisplayName
        ? { actorDisplayName: params.actorDisplayName }
        : {}),
    },
  };

  // Sentinel content — renderers (PR 18) read `slackMeta` to format the
  // reaction line; the literal text is never displayed to the model.
  const persisted = await addMessage(
    params.conversationId,
    "user",
    "[reaction]",
    { slackMeta: writeSlackMetadata(slackMeta) },
  );
  deliveryCrud.linkMessage(params.eventId, persisted.id);
  deliveryStatus.markProcessed(params.eventId);
}
