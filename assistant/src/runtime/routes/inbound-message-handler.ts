/**
 * Channel inbound message handler: validates, records, and routes inbound
 * messages from all channels. Handles ingress ACL, edits, guardian
 * verification, guardian action answers, approval interception, and
 * invite token redemption.
 */
// Side-effect imports: register channel invite transport adapters so the
// ACL enforcement module can resolve transports at runtime.
import {
  CHANNEL_IDS,
  INTERFACE_IDS,
  isChannelId,
  parseInterfaceId,
} from "../../channels/types.js";
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
import { getGuardianBinding } from "../channel-guardian-service.js";
import { deliverChannelReply } from "../gateway-client.js";
import { routeGuardianReply } from "../guardian-reply-router.js";
import { httpError } from "../http-errors.js";
import type {
  ApprovalConversationGenerator,
  ApprovalCopyGenerator,
  GuardianActionCopyGenerator,
  GuardianFollowUpConversationGenerator,
  MessageProcessor,
} from "../http-types.js";
import { resolveTrustContext } from "../trust-context-resolver.js";
import {
  canonicalChannelAssistantId,
  GUARDIAN_APPROVAL_TTL_MS,
} from "./channel-route-shared.js";
import { handleApprovalInterception } from "./guardian-approval-interception.js";
import { enforceIngressAcl } from "./inbound-stages/acl-enforcement.js";
import { processChannelMessageInBackground } from "./inbound-stages/background-dispatch.js";
import { handleBootstrapIntercept } from "./inbound-stages/bootstrap-intercept.js";
import { handleVerificationIntercept } from "./inbound-stages/verification-intercept.js";

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
