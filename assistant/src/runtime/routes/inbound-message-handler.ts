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
import {
  createApprovalConversationGenerator,
  createApprovalCopyGenerator,
} from "../../daemon/approval-generators.js";
import { processMessage } from "../../daemon/process-message.js";
import type { TrustContext } from "../../daemon/trust-context.js";
import { HeartbeatService } from "../../heartbeat/heartbeat-service.js";
import { getAttachmentsByIds } from "../../memory/attachments-store.js";
import {
  recordConversationSeenSignal,
  type SignalType,
} from "../../memory/conversation-attention-store.js";
import {
  addMessage,
  getMessageById,
  getMessages,
  selectSlackMetaCandidateMetadata,
  updateMessageMetadata,
} from "../../memory/conversation-crud.js";
import {
  clearPendingVerificationReply,
  getPendingVerificationReply,
} from "../../memory/delivery-channels.js";
import {
  findMessageBySourceId,
  linkMessage,
  recordInbound,
} from "../../memory/delivery-crud.js";
import { markProcessed } from "../../memory/delivery-status.js";
import { upsertBinding } from "../../memory/external-conversation-store.js";
import type { Message as ProviderMessage } from "../../messaging/provider-types.js";
import {
  backfillDm,
  backfillThreadWindowPage,
  type SlackBackfillWindowPage,
} from "../../messaging/providers/slack/backfill.js";
import {
  mergeSlackMetadata,
  readSlackMetadata,
  type SlackFileMetadata,
  type SlackMessageMetadata,
  writeSlackMetadata,
} from "../../messaging/providers/slack/message-metadata.js";
import { wrapUntrustedContent } from "../../security/untrusted-content.js";
import { canonicalizeInboundIdentity } from "../../util/canonicalize-identity.js";
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { deliverChannelReply } from "../gateway-client.js";
import { resolveTrustContext } from "../trust-context-resolver.js";
import { canonicalChannelAssistantId } from "./channel-route-shared.js";
import { BadRequestError } from "./errors.js";
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
import type { RouteHandlerArgs } from "./types.js";

const log = getLogger("runtime-http");

// Delete-lookup retry configuration. Delete webhooks can race ahead of
// the inbound handler's `linkMessage` call when the original message's
// agent loop is still running. Retrying buys time for the link to land
// before we drop the deletion signal. Mirrors the edit-intercept path's
// EDIT_LOOKUP_RETRIES / EDIT_LOOKUP_DELAY_MS constants.
let deleteLookupRetries = 5;
let deleteLookupDelayMs = 2000;

/**
 * Test-only override for the delete-lookup retry timings. Used by
 * tests that exercise the "no such message" path without waiting
 * through the full production backoff. Not exported from any barrel
 * file — only the test file imports it directly.
 */
export function _setDeleteLookupConfigForTests(
  retries: number,
  delayMs: number,
): void {
  deleteLookupRetries = retries;
  deleteLookupDelayMs = delayMs;
}

export async function handleChannelInbound({
  body: rawBody = {},
}: RouteHandlerArgs) {
  // Gateway-origin proof is enforced by route-policy middleware (svc_gateway
  // principal type required) before this handler runs. The exchange JWT
  // itself proves gateway origin.

  const assistantId = DAEMON_INTERNAL_ASSISTANT_ID;
  const approvalCopyGenerator = createApprovalCopyGenerator();
  const approvalConversationGenerator = createApprovalConversationGenerator();
  const heartbeatService = HeartbeatService.getInstance();

  const body = rawBody as {
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
    throw new BadRequestError("sourceChannel is required");
  }
  // Validate and narrow to canonical ChannelId at the boundary — the gateway
  // only sends well-known channel strings, so an unknown value is rejected.
  if (!isChannelId(body.sourceChannel)) {
    throw new BadRequestError(
      `Invalid sourceChannel: ${
        body.sourceChannel
      }. Valid values: ${CHANNEL_IDS.join(", ")}`,
    );
  }

  const sourceChannel = body.sourceChannel;

  if (!body.interface || typeof body.interface !== "string") {
    throw new BadRequestError("interface is required");
  }
  const sourceInterface = parseInterfaceId(body.interface);
  if (!sourceInterface) {
    throw new BadRequestError(
      `Invalid interface: ${body.interface}. Valid values: ${INTERFACE_IDS.join(
        ", ",
      )}`,
    );
  }

  if (!conversationExternalId || typeof conversationExternalId !== "string") {
    throw new BadRequestError("conversationExternalId is required");
  }
  if (
    !body.actorExternalId ||
    typeof body.actorExternalId !== "string" ||
    !body.actorExternalId.trim()
  ) {
    throw new BadRequestError("actorExternalId is required");
  }
  if (!externalMessageId || typeof externalMessageId !== "string") {
    throw new BadRequestError("externalMessageId is required");
  }

  // Reject non-string content regardless of whether attachments are present.
  if (content != null && typeof content !== "string") {
    throw new BadRequestError("content must be a string");
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
    throw new BadRequestError("content or attachmentIds is required");
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
    assistantId,
    externalMessageId,
  });
  if (aclResult.earlyResponse) return aclResult.earlyResponse;
  const { resolvedMember, guardianVerifyCode } = aclResult;

  // ── Slack delete propagation ──
  // Slack message_deleted events are forwarded by the gateway with the
  // sentinel `callbackData = "message_deleted"` and `sourceMetadata.messageId`
  // set to the original (deleted) message's ts. Short-circuit the rest of
  // the pipeline: the agent loop should not run for delete notifications,
  // and routing the event through approval / agent paths would be incorrect.
  // We mark the stored row as deleted in slackMeta but leave `content`
  // untouched for audit purposes — rendering elides based on the deletedAt
  // marker. Gated behind ingress ACL so non-members cannot drive deletes
  // (matches the edit-intercept policy).
  if (sourceChannel === "slack" && body.callbackData === "message_deleted") {
    const deletedMessageTs =
      typeof sourceMetadata?.messageId === "string"
        ? sourceMetadata.messageId
        : undefined;

    if (!deletedMessageTs) {
      log.debug(
        { conversationExternalId },
        "Slack message_deleted event missing sourceMetadata.messageId; ignoring",
      );
      return { accepted: true, deleted: false };
    }

    // Look up the stored message via the existing channel-event lookup.
    // The original message's externalMessageId may differ from its ts
    // (Slack populates client_msg_id when present), so we join via the
    // sourceMessageId column which records the ts explicitly.
    //
    // Retry with backoff mirrors the edit-intercept path: delete webhooks
    // can race ahead of `linkMessage` when the original message's agent
    // loop is still running. Without retries a delete that arrives in
    // that window is silently dropped and the deletion signal is lost.
    let original: { messageId: string; conversationId: string } | null = null;
    for (let attempt = 0; attempt <= deleteLookupRetries; attempt++) {
      original = findMessageBySourceId(
        sourceChannel,
        conversationExternalId,
        deletedMessageTs,
      );
      if (original) break;
      if (attempt < deleteLookupRetries) {
        log.info(
          {
            conversationExternalId,
            deletedMessageTs,
            attempt: attempt + 1,
            maxAttempts: deleteLookupRetries,
          },
          "Original message not linked yet, retrying delete lookup",
        );
        await new Promise((resolve) =>
          setTimeout(resolve, deleteLookupDelayMs),
        );
      }
    }

    if (!original) {
      log.debug(
        { conversationExternalId, deletedMessageTs },
        "No stored message found for Slack delete after retries; ignoring",
      );
      return { accepted: true, deleted: false };
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
      return { accepted: true, deleted: false };
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
      return { accepted: true, deleted: false };
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
      return { accepted: true, deleted: false };
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

    return {
      accepted: true,
      deleted: true,
      messageId: original.messageId,
    };
  }

  if (hasAttachments) {
    const resolved = getAttachmentsByIds(attachmentIds);
    if (resolved.length !== attachmentIds.length) {
      const resolvedIds = new Set(resolved.map((a) => a.id));
      const missing = attachmentIds.filter((id) => !resolvedIds.has(id));
      throw new BadRequestError(
        `Attachment IDs not found: ${missing.join(", ")}`,
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
    throw new BadRequestError("sourceMetadata.messageId is required for edits");
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
  const result = recordInbound(
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
    const pendingReply = getPendingVerificationReply(result.eventId);
    if (pendingReply) {
      try {
        await deliverChannelReply(replyCallbackUrl, {
          chatId: pendingReply.chatId,
          text: pendingReply.text,
          assistantId: pendingReply.assistantId,
        });
        clearPendingVerificationReply(result.eventId);
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
      return {
        accepted: true,
        duplicate: true,
        eventId: result.eventId,
      };
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
    upsertBinding({
      conversationId: result.conversationId,
      sourceChannel,
      externalChatId: conversationExternalId,
      externalUserId: canonicalSenderId ?? rawSenderId ?? null,
      displayName: body.actorDisplayName ?? null,
      username: body.actorUsername ?? null,
    });
  }

  // ── Slack reaction handling ──
  // Reactions arrive as regular `SlackInboundEvent`s with `callbackData`
  // prefixed `reaction:` (added) or `reaction_removed:` (removed).
  //
  // Two paths from here:
  //   1. Guardian approval-by-reaction. A `reaction:` (added) event from
  //      the guardian on an active approval prompt is consumed by
  //      `handleApprovalInterception` to apply the decision. In that case
  //      we do NOT persist the reaction as a transcript line — resolved
  //      guardian approval reactions have no transcript representation.
  //   2. All other reactions (non-guardian, no pending approval, stale,
  //      and any `reaction_removed:` event regardless of actor) fall
  //      through to `persistSlackReactionAsMessage` so Slack transcript
  //      rendering can surface them inline. Reactions never trigger an
  //      agent response, so we short-circuit before escalation and
  //      agent-loop dispatch in both cases.
  if (isSlackReactionEvent(body)) {
    // Approval interception runs only for reactions (added) — `reaction_removed`
    // never expresses an approval intent, so un-reacting is left as a pure
    // transcript signal. Gated by the same `replyCallbackUrl && !duplicate`
    // preconditions used by the standard approval interception call below.
    const isReactionAdded = body.callbackData?.startsWith("reaction:") === true;
    if (isReactionAdded && replyCallbackUrl && !result.duplicate) {
      const trustCtxForReaction: TrustContext = resolveTrustContext({
        assistantId: canonicalAssistantId,
        sourceChannel,
        conversationExternalId,
        actorExternalId: rawSenderId,
        actorUsername: body.actorUsername,
        actorDisplayName: body.actorDisplayName,
      });

      const approvalMessageTs =
        typeof sourceMetadata?.messageId === "string"
          ? sourceMetadata.messageId
          : undefined;

      const reactionApprovalResult = await handleApprovalInterception({
        conversationId: result.conversationId,
        callbackData: body.callbackData,
        content: trimmedContent,
        conversationExternalId,
        sourceChannel,
        actorExternalId: canonicalSenderId ?? rawSenderId,
        replyCallbackUrl,
        trustCtx: trustCtxForReaction,
        assistantId: canonicalAssistantId,
        approvalCopyGenerator,
        approvalConversationGenerator,
        approvalMessageTs,
      });

      // A real guardian decision was applied — short-circuit and skip the
      // reaction-persistence path so we do not double-record it as a
      // transcript line. All other interception outcomes (stale_ignored,
      // non-guardian, no pending approval) fall through to persistence.
      if (reactionApprovalResult.type === "guardian_decision_applied") {
        return {
          accepted: true,
          duplicate: false,
          eventId: result.eventId,
          approval: reactionApprovalResult.type,
        };
      }
    }

    const reactedMessageTs =
      typeof sourceMetadata?.messageId === "string"
        ? sourceMetadata.messageId
        : undefined;
    if (!reactedMessageTs) {
      log.debug(
        { conversationId: result.conversationId, eventId: result.eventId },
        "Skipping reaction persistence: missing sourceMetadata.messageId",
      );
      return {
        accepted: result.accepted,
        duplicate: result.duplicate,
        eventId: result.eventId,
      };
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

    return {
      accepted: result.accepted,
      duplicate: result.duplicate,
      eventId: result.eventId,
    };
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
  let slackRuntimeContextNotice: string | undefined;

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

      return {
        accepted: true,
        duplicate: false,
        eventId: result.eventId,
        approval: approvalResult.type,
      };
    }

    // When a callback payload was not handled by approval interception, it's
    // a stale button press with no pending approval. Return early regardless
    // of whether content/attachments are present — callback payloads always
    // have non-empty content (normalize.ts sets message.content to cbq.data),
    // so checking for empty content alone would miss stale callbacks.
    //
    // Reaction events (`reaction:` / `reaction_removed:`) are persisted by
    // the earlier `isSlackReactionEvent` branch and never reach here; guard
    // explicitly so a future refactor can't let a reaction ts drive a
    // "This approval request has been resolved." edit that would clobber
    // the user's reacted-to message.
    if (hasCallbackData && !isSlackReactionEvent(body)) {
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
        deliverChannelReply(replyCallbackUrl, {
          chatId: conversationExternalId,
          text: "This approval request has been resolved.",
          messageTs: approvalMessageTs,
          assistantId: canonicalAssistantId,
        }).catch((err) => {
          log.error(
            { err, conversationId: result.conversationId },
            "Failed to edit stale Slack approval message",
          );
        });
      }

      return {
        accepted: true,
        duplicate: false,
        eventId: result.eventId,
        approval: "stale_ignored",
      };
    }
  }

  // For new (non-duplicate) messages, run the secret ingress check
  // synchronously, then fire off the agent loop in the background.
  if (!result.duplicate) {
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
      markProcessed(result.eventId);
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
      // gateway forwards `thread_ts` under `sourceMetadata.threadId` and the
      // message's own ts under `sourceMetadata.messageId`. Persistence turns
      // this into a `slackMeta` sub-object in the row's metadata column so
      // the chronological renderer can reconstruct thread structure without
      // re-fetching from Slack.
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
              ...((body.actorDisplayName ?? body.actorUsername)
                ? {
                    displayName: body.actorDisplayName ?? body.actorUsername!,
                  }
                : {}),
            }
          : undefined;

      // Account identifier threaded into backfill so `resolveConnection()`
      // can pick the right workspace in multi-account setups. Best-effort:
      // the gateway forwards `sourceMetadata.account` when it knows which
      // Slack workspace the event came from; when absent, both helpers
      // fall back to the default-active connection.
      const slackAccount =
        sourceChannel === "slack" &&
        typeof sourceMetadata?.account === "string" &&
        sourceMetadata.account.length > 0
          ? sourceMetadata.account
          : undefined;

      // ── DM cold-start backfill ──
      // First time a Slack DM lands in a conversation that has fewer than
      // SLACK_DM_BACKFILL_WARM_THRESHOLD stored slackMeta messages, fetch a
      // window of recent history so the agent sees prior context. One-shot:
      // once persistence warms up past the threshold, subsequent DMs no
      // longer trigger backfill. Failures are non-fatal — the new message
      // proceeds without backfilled history.
      if (sourceChannel === "slack" && sourceChatType === "im") {
        // Exclude the just-arrived webhook message from the history window —
        // the normal inbound persistence path writes it separately, so
        // including it here would produce duplicate user turns. Only pass a
        // bound when we actually have a Slack ts (`<secs>.<micros>`): the
        // fallback path writes `externalMessageId` into `channelTs`, but that
        // identifier is not guaranteed to be a Slack ts, and Slack's
        // `conversations.history` rejects anything that isn't a ts string.
        const boundingTs = isSlackTs(sourceMessageId)
          ? sourceMessageId
          : undefined;
        await tryBackfillSlackDmIfCold({
          conversationId: result.conversationId,
          channelId: conversationExternalId,
          account: slackAccount,
          latestTs: boundingTs,
        });
      }

      // ── Thread gap/delta backfill ──
      // When a Slack thread reply arrives, compare the stored thread state
      // with the inbound message's ts and fetch only the bounded unseen
      // window. Initial late-join turns hydrate the earliest thread messages
      // plus a recent window adjacent to the inbound reply; later turns use
      // a delta window after the latest stored thread ts and before the
      // inbound ts. Awaited (mirrors the DM cold-start path above) so the
      // agent loop dispatched immediately afterwards observes hydrated
      // context. A late-join notice is added only to the current turn's
      // runtime context, not persisted as durable Slack metadata. Failures
      // are swallowed inside the helper so they never block dispatch.
      if (slackThreadTs) {
        const backfillResult = await triggerSlackThreadBackfillIfNeeded({
          conversationId: result.conversationId,
          channelId: conversationExternalId,
          threadTs: slackThreadTs,
          excludeChannelTs: slackInbound?.channelTs,
          account: slackAccount,
        });
        const lateJoinNotice = buildSlackLateJoinNotice(backfillResult);
        if (lateJoinNotice) slackRuntimeContextNotice = lateJoinNotice;
      }

      // Wrap non-guardian inbound content in external_content boundaries so
      // the model can distinguish external channel messages from instructions.
      const contentForProcessing =
        trustCtx.trustClass !== "guardian"
          ? wrapUntrustedContent(trimmedContent, {
              source: "webhook",
              sourceDetail: trustCtx.requesterIdentifier,
            })
          : trimmedContent;

      // Fire-and-forget: process the message and deliver the reply in the background.
      // The HTTP response returns immediately so the gateway webhook is not blocked.
      // The onEvent callback in processMessage registers pending interactions, and
      // approval interception (above) handles decisions via the pending-interactions tracker.
      processChannelMessageInBackground({
        processMessage,
        conversationId: result.conversationId,
        eventId: result.eventId,
        content: contentForProcessing,
        attachmentIds: hasAttachments ? attachmentIds : undefined,
        sourceChannel,
        sourceInterface,
        externalChatId: conversationExternalId,
        trustCtx,
        metadataHints,
        slackRuntimeContextNotice,
        metadataUxBrief,
        commandIntent,
        sourceLanguageCode,
        replyCallbackUrl,
        assistantId: canonicalAssistantId,
        approvalCopyGenerator,
        chatType: sourceChatType,
        slackInbound,
      });
    }
  }

  return {
    accepted: result.accepted,
    duplicate: result.duplicate,
    eventId: result.eventId,
  };
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
      {
        conversationId: params.conversationId,
        callbackData: params.callbackData,
      },
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
    ...(params.actorDisplayName
      ? { displayName: params.actorDisplayName }
      : {}),
    reaction: {
      emoji: parsed.emoji,
      targetChannelTs: params.reactedMessageTs,
      op: parsed.op,
      ...(params.actorDisplayName
        ? { actorDisplayName: params.actorDisplayName }
        : {}),
    },
  };

  // Sentinel content — Slack transcript renderers read `slackMeta` to format
  // the reaction line; the literal text is never displayed to the model.
  const persisted = await addMessage(
    params.conversationId,
    "user",
    "[reaction]",
    { slackMeta: writeSlackMetadata(slackMeta) },
    { skipIndexing: true },
  );
  linkMessage(params.eventId, persisted.id);
  markProcessed(params.eventId);
}

/**
 * Threshold of stored Slack-tagged messages below which a conversation is
 * considered "cold" and eligible for one-shot backfill. The number is
 * deliberately small but greater than 1 so a single sentinel row (e.g. a
 * stale reaction) does not disqualify a conversation that has no real
 * message history yet.
 */
const SLACK_DM_BACKFILL_WARM_THRESHOLD = 3;

/**
 * Shape-check for a Slack `ts` value. Slack IDs messages by `<seconds>.<micros>`
 * strings (e.g. `"1700000000.000100"`). The daemon also stores an
 * `externalMessageId` derived from the gateway's dedupe key which follows a
 * different format, so any path that feeds a ts to Slack's API
 * (`conversations.history`'s `latest`, etc.) must shape-check first — Slack
 * rejects non-ts arguments with `invalid_arguments`, and passing a malformed
 * bound silently disables the intended history window.
 */
function isSlackTs(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d+\.\d+$/.test(value);
}

/**
 * Batch size used when pulling candidate rows from SQL. A bare
 * `LIKE '%"slackMeta"%'` match can include rows whose metadata JSON is
 * malformed or carries the literal under an unrelated key, so we fetch in
 * batches and re-validate each candidate with Zod. The threshold is tiny
 * (see `SLACK_DM_BACKFILL_WARM_THRESHOLD`), so a 10× batch is a trivial
 * scan while letting a handful of bad rows not starve the count.
 */
const SLACK_DM_CANDIDATE_BATCH_SIZE = SLACK_DM_BACKFILL_WARM_THRESHOLD * 10;

/**
 * Absolute cap on candidate rows inspected per webhook to classify a DM as
 * warm. If this many substring matches have been examined without reaching
 * the valid-row threshold, treat the conversation as cold — a scan this
 * deep already dominates the critical-path budget and the cold-start
 * backfill path is itself idempotent against re-runs.
 */
const SLACK_DM_CANDIDATE_MAX_SCAN = SLACK_DM_BACKFILL_WARM_THRESHOLD * 20;

/**
 * Count messages in a conversation whose `metadata` carries a well-formed
 * `slackMeta` envelope, capped at the warm threshold. SQL prefilters with
 * `LIKE` + `LIMIT`/`OFFSET` so warm DM conversations never scan the full
 * table on the webhook critical path, and each candidate is re-validated
 * through `readSlackMetadata` — a bare substring match would otherwise
 * wrongly count rows whose metadata is truncated, parses but fails schema
 * validation, or happens to contain the literal `"slackMeta"` under an
 * unrelated key. Pulls candidates in batches, continuing until either the
 * threshold of *valid* rows is reached or the per-call scan cap is hit, so
 * a cluster of malformed rows at the head of the scan cannot starve the
 * count and misclassify a warm conversation as cold.
 */
function countSlackMetaMessages(conversationId: string): number {
  let count = 0;
  let offset = 0;
  while (offset < SLACK_DM_CANDIDATE_MAX_SCAN) {
    const remaining = SLACK_DM_CANDIDATE_MAX_SCAN - offset;
    const batchLimit = Math.min(SLACK_DM_CANDIDATE_BATCH_SIZE, remaining);
    const candidates = selectSlackMetaCandidateMetadata(
      conversationId,
      batchLimit,
      offset,
    );
    if (candidates.length === 0) return count;
    for (const raw of candidates) {
      if (readSlackMetadataFromMessageMetadata(raw)) {
        count++;
        if (count >= SLACK_DM_BACKFILL_WARM_THRESHOLD) return count;
      }
    }
    if (candidates.length < batchLimit) return count;
    offset += candidates.length;
  }
  return count;
}

function readSlackMetadataFromMessageMetadata(
  metadata: string | null | undefined,
): SlackMessageMetadata | null {
  if (!metadata) return null;
  let parent: Record<string, unknown> | null = null;
  try {
    const parsed = JSON.parse(metadata) as unknown;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      parent = parsed as Record<string, unknown>;
    }
  } catch {
    return null;
  }
  if (!parent) return null;
  const raw = parent.slackMeta;
  if (typeof raw !== "string") return null;
  return readSlackMetadata(raw);
}

/**
 * Build the set of `slackMeta.channelTs` values already stored on a
 * conversation. Used by both DM cold-start backfill and thread gap/delta
 * backfill to dedupe rows so a partial prior backfill (or a single message
 * that was already persisted via the live ingress path) does not double-write.
 */
function readStoredSlackChannelTs(conversationId: string): Set<string> {
  const seen = new Set<string>();
  for (const row of getMessages(conversationId)) {
    const meta = readSlackMetadataFromMessageMetadata(row.metadata);
    // Only message rows represent stored Slack messages. Reaction rows carry
    // `channelTs` equal to the target message's ts, so including them would
    // make a reaction on a thread parent wrongly short-circuit thread
    // backfill (the parent itself may still be unseen).
    if (meta && meta.eventKind === "message") seen.add(meta.channelTs);
  }
  return seen;
}

interface ParsedSlackTimestamp {
  seconds: bigint;
  micros: bigint;
}

function parseSlackTimestamp(
  ts: string | undefined,
): ParsedSlackTimestamp | null {
  if (!ts) return null;
  const match = /^(\d+)\.(\d{1,6})$/.exec(ts);
  if (!match) return null;
  const micros = BigInt(match[2]);
  if (micros > 999_999n) return null;
  return {
    seconds: BigInt(match[1]),
    micros,
  };
}

function compareSlackTimestamps(left: string, right: string): number | null {
  const parsedLeft = parseSlackTimestamp(left);
  const parsedRight = parseSlackTimestamp(right);
  if (!parsedLeft || !parsedRight) return null;
  if (parsedLeft.seconds < parsedRight.seconds) return -1;
  if (parsedLeft.seconds > parsedRight.seconds) return 1;
  if (parsedLeft.micros < parsedRight.micros) return -1;
  if (parsedLeft.micros > parsedRight.micros) return 1;
  return 0;
}

interface StoredSlackThreadState {
  storedChannelTs: Set<string>;
  latestStoredThreadTs: string | undefined;
}

function readStoredSlackThreadState(
  conversationId: string,
  threadTs: string,
): StoredSlackThreadState {
  const storedChannelTs = new Set<string>();
  let latestStoredThreadTs: string | undefined;

  for (const row of getMessages(conversationId)) {
    const meta = readSlackMetadataFromMessageMetadata(row.metadata);
    if (!meta || meta.eventKind !== "message") continue;
    if (meta.channelTs !== threadTs && meta.threadTs !== threadTs) continue;

    storedChannelTs.add(meta.channelTs);
    if (!parseSlackTimestamp(meta.channelTs)) continue;
    if (
      latestStoredThreadTs === undefined ||
      compareSlackTimestamps(meta.channelTs, latestStoredThreadTs) === 1
    ) {
      latestStoredThreadTs = meta.channelTs;
    }
  }

  return { storedChannelTs, latestStoredThreadTs };
}

/**
 * Persist a single backfilled Slack message as a `messages` row with a
 * `slackMeta` envelope.
 *
 * Shared insertion point for any path that hydrates Slack history lazily
 * (DM cold-start backfill, thread gap/delta backfill, etc.). Role is derived
 * from `message.metadata.isBot` — bot-authored rows map to `"assistant"` so
 * our own prior replies (and any other bot traffic) are not rehydrated as
 * user turns, which would otherwise corrupt speaker attribution and make
 * the assistant treat its own outputs as new user input on later turns.
 * Caller is responsible for dedup checks before invoking; this helper
 * performs no idempotency check itself.
 */
async function persistBackfilledSlackMessage(params: {
  conversationId: string;
  channelId: string;
  message: ProviderMessage;
}): Promise<void> {
  const { message } = params;
  const slackFiles = readSlackFilesFromProviderMetadata(message.metadata);
  const slackMeta: SlackMessageMetadata = {
    source: "slack",
    channelId: params.channelId,
    channelTs: message.id,
    eventKind: "message",
    ...(message.threadId ? { threadTs: message.threadId } : {}),
    ...(message.sender?.name ? { displayName: message.sender.name } : {}),
    ...(slackFiles.length > 0 ? { slackFiles } : {}),
  };
  const role = message.metadata?.isBot === true ? "assistant" : "user";
  await addMessage(params.conversationId, role, message.text ?? "", {
    slackMeta: writeSlackMetadata(slackMeta),
  });
}

function readSlackFilesFromProviderMetadata(
  metadata: Record<string, unknown> | undefined,
): SlackFileMetadata[] {
  const raw = metadata?.slackFiles;
  if (!Array.isArray(raw)) return [];
  const files: SlackFileMetadata[] = [];
  for (const item of raw) {
    if (item === null || typeof item !== "object" || Array.isArray(item)) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!name) continue;
    files.push({
      ...(typeof record.id === "string" && record.id.length > 0
        ? { id: record.id }
        : {}),
      name,
      ...(typeof record.mimetype === "string" && record.mimetype.length > 0
        ? { mimetype: record.mimetype }
        : {}),
    });
  }
  return files;
}

/**
 * In-memory map of in-flight DM cold-start backfills keyed by conversationId.
 * Concurrent inbound DMs to the same cold conversation share a single
 * backfill promise instead of each issuing their own Slack history fetch and
 * write — without this, two near-simultaneous DMs would both observe a cold
 * count, both fetch the same history window, and both insert duplicate rows
 * (channelTs lives inside a JSON metadata blob, so the DB has no uniqueness
 * constraint to fall back on).
 */
const _dmBackfillInFlight = new Map<string, Promise<void>>();

/**
 * One-shot DM cold-start backfill. When a Slack DM lands in a conversation
 * with fewer than `SLACK_DM_BACKFILL_WARM_THRESHOLD` stored Slack-tagged
 * messages, fetch a window of recent history via `backfillDm` and persist
 * each returned message with a `slackMeta` envelope. Already-stored
 * messages (matched by `slackMeta.channelTs`) are skipped to keep the
 * operation idempotent across retries.
 *
 * Failure semantics: any error is logged at WARN and swallowed. The caller
 * proceeds with only the new message.
 */
async function tryBackfillSlackDmIfCold(params: {
  conversationId: string;
  channelId: string;
  account?: string;
  latestTs?: string;
}): Promise<void> {
  const existing = _dmBackfillInFlight.get(params.conversationId);
  if (existing) {
    await existing;
    return;
  }
  const promise = runBackfillSlackDmIfCold(params).finally(() => {
    _dmBackfillInFlight.delete(params.conversationId);
  });
  _dmBackfillInFlight.set(params.conversationId, promise);
  await promise;
}

async function runBackfillSlackDmIfCold(params: {
  conversationId: string;
  channelId: string;
  account?: string;
  latestTs?: string;
}): Promise<void> {
  try {
    const storedCount = countSlackMetaMessages(params.conversationId);
    if (storedCount >= SLACK_DM_BACKFILL_WARM_THRESHOLD) {
      return;
    }

    // Pass the webhook message's ts as `before` (Slack's `latest`,
    // exclusive) so history never contains the message that's about to be
    // persisted by the live inbound path. Without this bound the just-arrived
    // DM would be written twice — once here and once via normal persistence —
    // producing duplicate user turns.
    const fetched = await backfillDm(params.channelId, {
      limit: 50,
      account: params.account,
      before: params.latestTs,
    });
    if (fetched.length === 0) {
      log.debug(
        { conversationId: params.conversationId, channelId: params.channelId },
        "DM backfill returned no messages",
      );
      return;
    }

    const seen = readStoredSlackChannelTs(params.conversationId);
    let written = 0;
    // Slack's conversation.history returns most-recent first. Reverse so
    // rows insert in chronological order, giving stable createdAt ordering
    // and a transcript that reads correctly when the renderer joins on
    // monotonic createdAt.
    const ordered = [...fetched].reverse();
    for (const message of ordered) {
      if (seen.has(message.id)) continue;
      try {
        await persistBackfilledSlackMessage({
          conversationId: params.conversationId,
          channelId: params.channelId,
          message,
        });
        seen.add(message.id);
        written++;
      } catch (perRowErr) {
        log.warn(
          {
            err: perRowErr,
            conversationId: params.conversationId,
            channelId: params.channelId,
            channelTs: message.id,
          },
          "Failed to persist backfilled DM row; continuing",
        );
      }
    }

    log.info(
      {
        conversationId: params.conversationId,
        channelId: params.channelId,
        fetched: fetched.length,
        written,
      },
      "DM cold-start backfill complete",
    );
  } catch (err) {
    // `channel_not_found` almost always means the resolved connection is
    // pointing at the wrong Slack workspace (a real config bug), so log it
    // at ERROR to match backfill's rethrow contract. Other failures
    // (timeout, auth, ratelimited, …) stay at WARN — they're expected
    // transient blips and the caller proceeds without backfilled history.
    const channelNotFound =
      err instanceof Error && /channel_not_found/i.test(err.message);
    const payload = {
      err,
      conversationId: params.conversationId,
      channelId: params.channelId,
      account: params.account,
    };
    if (channelNotFound) {
      log.error(
        payload,
        "DM cold-start backfill hit channel_not_found — connection likely points at the wrong Slack workspace",
      );
    } else {
      log.warn(
        payload,
        "DM cold-start backfill failed; proceeding without history",
      );
    }
  }
}

// ---------------------------------------------------------------------------
// Slack thread backfill on gap detection
// ---------------------------------------------------------------------------

/**
 * In-memory TTL cache keyed by
 * `<conversationId>:<threadTs>:<lowerBoundTs>:<upperBoundTs>`. Tracks recent
 * thread-backfill windows so repeated triggers for the same Slack gap do not
 * re-fetch identical rows while later replies in the same thread can still
 * request newer unseen windows.
 *
 * Exported only for tests; production callers should use
 * {@link triggerSlackThreadBackfillIfNeeded}.
 */
export const _backfillTriggerCache = new Map<string, number>();

const BACKFILL_TRIGGER_TTL_MS = 10 * 60 * 1000; // 10 minutes
const BACKFILL_TRIGGER_CACHE_MAX = 1_000;
const SLACK_THREAD_INITIAL_EARLY_LIMIT = 25;
const SLACK_THREAD_INITIAL_RECENT_LIMIT = 50;
const SLACK_THREAD_INITIAL_RECENT_MAX_PAGES = 5;
const SLACK_THREAD_DELTA_LIMIT = 50;
const SLACK_THREAD_UPPER_ADJACENT_MAX_ATTEMPTS = 5;
const MICROS_PER_SECOND = 1_000_000n;
const SLACK_UPPER_ADJACENT_EXPANDING_WINDOWS_MICROS = [
  5n * 60n * MICROS_PER_SECOND,
  60n * 60n * MICROS_PER_SECOND,
  24n * 60n * 60n * MICROS_PER_SECOND,
  7n * 24n * 60n * 60n * MICROS_PER_SECOND,
  30n * 24n * 60n * 60n * MICROS_PER_SECOND,
];
const SLACK_UPPER_ADJACENT_SHRINKING_WINDOWS_MICROS = [
  60n * MICROS_PER_SECOND,
  10n * MICROS_PER_SECOND,
  MICROS_PER_SECOND,
  100_000n,
  1_000n,
];

export interface SlackThreadBackfillResult {
  fetched: number;
  persisted: number;
  reason?: SlackBackfillReason;
  omittedMiddle: boolean;
}

type SlackBackfillReason = "thread_late_join" | "thread_delta";

function emptySlackThreadBackfillResult(): SlackThreadBackfillResult {
  return { fetched: 0, persisted: 0, omittedMiddle: false };
}

function pruneBackfillCacheIfNeeded(): void {
  if (_backfillTriggerCache.size < BACKFILL_TRIGGER_CACHE_MAX) return;
  const now = Date.now();
  for (const [key, ts] of _backfillTriggerCache) {
    if (now - ts >= BACKFILL_TRIGGER_TTL_MS) {
      _backfillTriggerCache.delete(key);
    }
  }
  // If still over the cap after TTL sweep, drop the oldest entries (LRU-ish).
  if (_backfillTriggerCache.size >= BACKFILL_TRIGGER_CACHE_MAX) {
    const entries = [..._backfillTriggerCache.entries()].sort(
      (a, b) => a[1] - b[1],
    );
    const toRemove = entries.slice(
      0,
      entries.length - BACKFILL_TRIGGER_CACHE_MAX + 1,
    );
    for (const [key] of toRemove) {
      _backfillTriggerCache.delete(key);
    }
  }
}

function isBackfillRecentlyTriggered(cacheKey: string): boolean {
  const ts = _backfillTriggerCache.get(cacheKey);
  if (ts === undefined) return false;
  if (Date.now() - ts >= BACKFILL_TRIGGER_TTL_MS) {
    _backfillTriggerCache.delete(cacheKey);
    return false;
  }
  return true;
}

interface SlackInitialThreadWindowsResult {
  messages: ProviderMessage[];
  omittedMiddle: boolean;
}

interface SlackUpperAdjacentWindowResult {
  messages: ProviderMessage[];
  omittedEarlierContent: boolean;
  truncatedBeforeUpperBound: boolean;
}

function slackPageHasMore(page: SlackBackfillWindowPage): boolean {
  return page.hasMore || page.nextCursor !== undefined;
}

function minSlackMessageTs(messages: ProviderMessage[]): string | undefined {
  return sortSlackProviderMessages(messages)[0]?.id;
}

function maxSlackMessageTs(messages: ProviderMessage[]): string | undefined {
  const sorted = sortSlackProviderMessages(messages);
  return sorted[sorted.length - 1]?.id;
}

function slackTimestampToMicros(ts: string | undefined): bigint | null {
  const parsed = parseSlackTimestamp(ts);
  if (!parsed) return null;
  return parsed.seconds * MICROS_PER_SECOND + parsed.micros;
}

function slackTimestampFromMicros(totalMicros: bigint): string | undefined {
  if (totalMicros < 0n) return undefined;
  const seconds = totalMicros / MICROS_PER_SECOND;
  const micros = totalMicros % MICROS_PER_SECOND;
  return `${seconds.toString()}.${micros.toString().padStart(6, "0")}`;
}

function didInitialWindowsLeaveGap(params: {
  early: SlackBackfillWindowPage;
  recent: SlackBackfillWindowPage;
  recentScanTruncated: boolean;
}): boolean {
  if (params.recentScanTruncated) return true;
  if (!slackPageHasMore(params.early)) return false;
  const earlyMax = maxSlackMessageTs(params.early.messages);
  const recentMin = minSlackMessageTs(params.recent.messages);
  if (!earlyMax || !recentMin) return false;
  const compared = compareSlackTimestamps(earlyMax, recentMin);
  return compared !== null && compared < 0;
}

async function fetchSlackThreadUpperAdjacentWindow(params: {
  channelId: string;
  threadTs: string;
  upperBoundTs: string;
  lowerBoundTs?: string;
  limit: number;
  account?: string;
  maxAttempts?: number;
}): Promise<SlackUpperAdjacentWindowResult> {
  // Slack returns bounded conversations.replies pages earliest-first. To keep
  // the context closest to the inbound mention, narrow by timestamp instead
  // of cursoring forward from the oldest page in the bounded range.
  const upperMicros = slackTimestampToMicros(params.upperBoundTs);
  if (upperMicros === null) {
    const page = await backfillThreadWindowPage(
      params.channelId,
      params.threadTs,
      {
        limit: params.limit,
        account: params.account,
        before: params.upperBoundTs,
        ...(params.lowerBoundTs !== undefined
          ? { after: params.lowerBoundTs }
          : {}),
      },
    );
    return {
      messages: page.messages,
      omittedEarlierContent: slackPageHasMore(page),
      truncatedBeforeUpperBound: slackPageHasMore(page),
    };
  }

  const lowerMicros = slackTimestampToMicros(params.lowerBoundTs);
  const maxAttempts =
    params.maxAttempts ?? SLACK_THREAD_UPPER_ADJACENT_MAX_ATTEMPTS;
  let attempts = 0;
  let safePage: SlackBackfillWindowPage | undefined;
  let safeAfterTs: string | undefined;
  let truncatedBeforeUpperBound = false;

  const fetchWindow = async (
    windowMicros: bigint,
  ): Promise<{
    page: SlackBackfillWindowPage;
    after?: string;
    reachedLowerBound: boolean;
  }> => {
    let candidateMicros = upperMicros - windowMicros;
    let reachedLowerBound = false;
    if (lowerMicros !== null && candidateMicros <= lowerMicros) {
      candidateMicros = lowerMicros;
      reachedLowerBound = true;
    }
    const after = reachedLowerBound
      ? params.lowerBoundTs
      : slackTimestampFromMicros(candidateMicros);
    const page = await backfillThreadWindowPage(
      params.channelId,
      params.threadTs,
      {
        limit: params.limit,
        account: params.account,
        before: params.upperBoundTs,
        ...(after !== undefined ? { after } : {}),
      },
    );
    attempts++;
    return { page, after, reachedLowerBound };
  };

  const considerWindow = async (windowMicros: bigint): Promise<boolean> => {
    const { page, after, reachedLowerBound } = await fetchWindow(windowMicros);
    if (slackPageHasMore(page)) {
      truncatedBeforeUpperBound = true;
      return false;
    }

    safePage = page;
    safeAfterTs = after;
    return page.messages.length < params.limit && !reachedLowerBound;
  };

  for (const windowMicros of SLACK_UPPER_ADJACENT_EXPANDING_WINDOWS_MICROS) {
    if (attempts >= maxAttempts) break;
    const shouldExpand = await considerWindow(windowMicros);
    if (!shouldExpand) break;
  }

  if (truncatedBeforeUpperBound && !safePage && attempts < maxAttempts) {
    for (const windowMicros of SLACK_UPPER_ADJACENT_SHRINKING_WINDOWS_MICROS) {
      if (attempts >= maxAttempts) break;
      await considerWindow(windowMicros);
      if (safePage) break;
    }
  }

  if (!safePage) {
    const after = slackTimestampFromMicros(upperMicros - 2n);
    const page = await backfillThreadWindowPage(
      params.channelId,
      params.threadTs,
      {
        limit: params.limit,
        account: params.account,
        before: params.upperBoundTs,
        ...(after !== undefined ? { after } : {}),
      },
    );
    safePage = page;
    safeAfterTs = after;
    truncatedBeforeUpperBound =
      truncatedBeforeUpperBound || slackPageHasMore(page);
  }
  if (!safePage) {
    return {
      messages: [],
      omittedEarlierContent: true,
      truncatedBeforeUpperBound: true,
    };
  }

  let omittedEarlierContent = truncatedBeforeUpperBound;
  if (
    !omittedEarlierContent &&
    params.lowerBoundTs !== undefined &&
    safeAfterTs !== undefined &&
    compareSlackTimestamps(params.lowerBoundTs, safeAfterTs) === -1
  ) {
    const coverageProbe = await backfillThreadWindowPage(
      params.channelId,
      params.threadTs,
      {
        limit: 1,
        account: params.account,
        after: params.lowerBoundTs,
        before: safeAfterTs,
      },
    );
    omittedEarlierContent =
      coverageProbe.messages.length > 0 || slackPageHasMore(coverageProbe);
  }

  return {
    messages: safePage.messages,
    omittedEarlierContent,
    truncatedBeforeUpperBound,
  };
}

async function fetchInitialSlackThreadWindows(params: {
  channelId: string;
  threadTs: string;
  upperBoundTs?: string;
  account?: string;
}): Promise<SlackInitialThreadWindowsResult> {
  if (!params.upperBoundTs) {
    const early = await backfillThreadWindowPage(
      params.channelId,
      params.threadTs,
      {
        limit: SLACK_THREAD_INITIAL_EARLY_LIMIT,
        account: params.account,
      },
    );
    return {
      messages: sortSlackProviderMessages(
        dedupeSlackProviderMessages(early.messages),
      ),
      omittedMiddle: slackPageHasMore(early),
    };
  }
  const [early, recentResult] = await Promise.all([
    backfillThreadWindowPage(params.channelId, params.threadTs, {
      limit: SLACK_THREAD_INITIAL_EARLY_LIMIT,
      account: params.account,
    }),
    fetchSlackThreadUpperAdjacentWindow({
      channelId: params.channelId,
      threadTs: params.threadTs,
      account: params.account,
      upperBoundTs: params.upperBoundTs,
      limit: SLACK_THREAD_INITIAL_RECENT_LIMIT,
      maxAttempts: SLACK_THREAD_INITIAL_RECENT_MAX_PAGES,
    }),
  ]);
  const recent: SlackBackfillWindowPage = {
    messages: recentResult.messages,
    hasMore: recentResult.truncatedBeforeUpperBound,
  };
  return {
    messages: sortSlackProviderMessages(
      dedupeSlackProviderMessages([...early.messages, ...recent.messages]),
    ),
    omittedMiddle:
      recentResult.omittedEarlierContent ||
      didInitialWindowsLeaveGap({
        early,
        recent,
        recentScanTruncated: recentResult.truncatedBeforeUpperBound,
      }),
  };
}

function dedupeSlackProviderMessages(
  messages: ProviderMessage[],
): ProviderMessage[] {
  const byTs = new Map<string, ProviderMessage>();
  for (const message of messages) {
    if (!message.id || byTs.has(message.id)) continue;
    byTs.set(message.id, message);
  }
  return [...byTs.values()];
}

function sortSlackProviderMessages(
  messages: ProviderMessage[],
): ProviderMessage[] {
  return [...messages].sort((left, right) => {
    const compared = compareSlackTimestamps(left.id, right.id);
    if (compared !== null) return compared;
    return left.id.localeCompare(right.id);
  });
}

function buildSlackLateJoinNotice(
  result: SlackThreadBackfillResult,
): string | null {
  if (result.reason !== "thread_late_join" || result.persisted === 0) {
    return null;
  }
  const omitted = result.omittedMiddle
    ? " Some middle thread messages were intentionally omitted from this turn's hydrated context to keep latency bounded."
    : "";
  return `Slack context note: this turn joined an existing thread. ${result.persisted} earlier thread message${result.persisted === 1 ? " was" : "s were"} backfilled before the current message.${omitted}`;
}

/**
 * Lazily backfill Slack thread gaps for an inbound thread reply.
 *
 * When a reply arrives for a thread with unseen Slack history, the assistant
 * fetches bounded `conversations.replies` pages via
 * {@link backfillThreadWindowPage}, persists each unseen message as a
 * `messages` row with a `slackMeta` envelope, and skips duplicates whose `ts`
 * already appears in the conversation.
 *
 * Behavior contracts:
 * - **Thread-state gap detection.** Looks up stored Slack message rows for
 *   the same thread, excluding reactions, then fetches only the unseen
 *   `(latestStoredThreadTs, excludeChannelTs)` window when the inbound Slack
 *   timestamp is newer than local state.
 * - **Upper-bound windows.** Initial late-join backfill combines an early
 *   thread page with a recent page adjacent to the inbound ts; delta backfill
 *   fetches the page nearest the inbound upper bound so the current turn sees
 *   the most relevant context while keeping latency bounded.
 * - **Exact-window TTL cache.** A 10-minute in-memory cache prevents repeated
 *   fetches for the same exact lower/upper bounded window, without
 *   suppressing later unseen windows in the same thread.
 * - **Failure-tolerant.** Any error (Slack API failure, DB error, malformed
 *   payload) is logged at `warn` and swallowed — the inbound turn must
 *   never block on backfill.
 */
export async function triggerSlackThreadBackfillIfNeeded(params: {
  conversationId: string;
  channelId: string;
  threadTs: string;
  /**
   * The inbound message's own `channelTs`. Pre-seeded into the dedup set so
   * this helper does not re-persist the just-received message when Slack's
   * `conversations.replies` returns it in the thread window. Necessary
   * because thread backfill runs concurrently with
   * `processChannelMessageInBackground`, so the inbound row may not yet be
   * in the DB when the thread-state scan snapshots the conversation.
   */
  excludeChannelTs?: string;
  /**
   * OAuth account identifier used to disambiguate which Slack workspace the
   * backfill should read from in multi-account setups. Passed through to
   * `backfillThreadWindowPage` page requests and then `resolveConnection`.
   * Best-effort: if omitted, the resolver falls back to the default-active
   * connection.
   */
  account?: string;
}): Promise<SlackThreadBackfillResult> {
  const { conversationId, channelId, threadTs, excludeChannelTs, account } =
    params;

  try {
    const upperBoundTs = parseSlackTimestamp(excludeChannelTs)
      ? excludeChannelTs
      : undefined;
    const threadState = readStoredSlackThreadState(conversationId, threadTs);
    const lowerBoundTs = threadState.latestStoredThreadTs;

    // Pre-seed only after computing lowerBoundTs. The current inbound row
    // may not have reached the DB yet, and treating it as stored state would
    // hide the gap we need to fetch.
    if (excludeChannelTs) threadState.storedChannelTs.add(excludeChannelTs);

    if (upperBoundTs && lowerBoundTs) {
      const lowerVsUpper = compareSlackTimestamps(lowerBoundTs, upperBoundTs);
      if (lowerVsUpper !== null && lowerVsUpper >= 0) {
        return emptySlackThreadBackfillResult();
      }
    } else if (!upperBoundTs && lowerBoundTs) {
      return emptySlackThreadBackfillResult();
    }

    const cacheKey = `${conversationId}:${threadTs}:${
      lowerBoundTs ?? "none"
    }:${upperBoundTs ?? "unbounded"}`;
    if (isBackfillRecentlyTriggered(cacheKey)) {
      return emptySlackThreadBackfillResult();
    }

    // Mark the trigger before issuing the network call. Doing this first
    // means a second concurrent request for the same window short-circuits
    // immediately even while the first call is still awaiting the Slack API.
    // The cost is a slightly larger window where a transient Slack failure
    // suppresses a retry, which the next reply outside the TTL (or a daemon
    // restart) will re-attempt anyway.
    _backfillTriggerCache.set(cacheKey, Date.now());
    pruneBackfillCacheIfNeeded();

    const isInitialLateJoin =
      lowerBoundTs === undefined &&
      threadState.storedChannelTs.size === (excludeChannelTs ? 1 : 0);
    const reason: SlackBackfillReason = isInitialLateJoin
      ? "thread_late_join"
      : "thread_delta";
    let omittedMiddle = false;
    let fetched: ProviderMessage[];
    if (isInitialLateJoin) {
      const initial = await fetchInitialSlackThreadWindows({
        channelId,
        threadTs,
        upperBoundTs,
        account,
      });
      fetched = initial.messages;
      omittedMiddle = initial.omittedMiddle;
    } else {
      const window = await fetchSlackThreadUpperAdjacentWindow({
        channelId,
        threadTs,
        limit: SLACK_THREAD_DELTA_LIMIT,
        account,
        ...(lowerBoundTs !== undefined ? { lowerBoundTs } : {}),
        upperBoundTs: upperBoundTs ?? threadTs,
      });
      fetched = window.messages;
      omittedMiddle = window.omittedEarlierContent;
    }
    if (fetched.length === 0) {
      log.debug(
        { conversationId, channelId, threadTs },
        "Slack thread backfill returned no messages",
      );
      return emptySlackThreadBackfillResult();
    }

    let persisted = 0;
    for (const message of fetched) {
      if (!message.id) continue;
      if (threadState.storedChannelTs.has(message.id)) continue;
      try {
        await persistBackfilledSlackMessage({
          conversationId,
          channelId,
          message,
        });
        threadState.storedChannelTs.add(message.id);
        persisted++;
      } catch (err) {
        log.warn(
          { err, conversationId, channelId, threadTs, channelTs: message.id },
          "Failed to persist backfilled Slack thread message",
        );
      }
    }

    log.info(
      {
        conversationId,
        channelId,
        threadTs,
        persisted,
        fetched: fetched.length,
        omittedMiddle,
      },
      "Slack thread backfill persisted thread messages",
    );
    return {
      fetched: fetched.length,
      persisted,
      reason,
      omittedMiddle,
    };
  } catch (err) {
    // `channel_not_found` almost always means the resolved connection is
    // pointing at the wrong Slack workspace (a real config bug), so log it
    // at ERROR to match backfill's rethrow contract. Other failures
    // (timeout, auth, ratelimited, …) stay at WARN — they're expected
    // transient blips and dispatch proceeds without the backfilled thread rows.
    const channelNotFound =
      err instanceof Error && /channel_not_found/i.test(err.message);
    const payload = { err, conversationId, channelId, threadTs, account };
    if (channelNotFound) {
      log.error(
        payload,
        "Slack thread backfill hit channel_not_found — connection likely points at the wrong Slack workspace",
      );
    } else {
      log.warn(payload, "Slack thread backfill failed; proceeding without it");
    }
    return emptySlackThreadBackfillResult();
  }
}
