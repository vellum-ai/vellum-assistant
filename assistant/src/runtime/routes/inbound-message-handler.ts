/**
 * Channel inbound message handler: validates, records, and routes inbound
 * messages from all channels. Handles ingress ACL, edits, guardian
 * verification, guardian action answers, and approval interception.
 * Invite token/code redemption is intercepted at gateway ingress before
 * messages reach this handler.
 */
import type { SourceMetadata } from "@vellumai/gateway-client";
import {
  ADMISSION_POLICY_DEFAULT,
  type AdmissionPolicy,
  isAdmissionPolicy,
} from "@vellumai/gateway-client";

import {
  attachmentsToContentBlocks,
  type MessageAttachmentInput,
} from "../../agent/attachments.js";
import {
  CHANNEL_IDS,
  INTERFACE_IDS,
  isChannelId,
  parseInterfaceId,
} from "../../channels/types.js";
import { isAssistantFeatureFlagEnabled } from "../../config/assistant-feature-flags.js";
import { getConfig } from "../../config/loader.js";
import { channelStatusToMemberStatus } from "../../contacts/member-status.js";
import {
  createApprovalConversationGenerator,
  createApprovalCopyGenerator,
} from "../../daemon/approval-generators.js";
import { findConversation } from "../../daemon/conversation-registry.js";
import {
  canonicalizeTimeZone,
  resolveTurnTimezoneContext,
} from "../../daemon/date-context.js";
import { getDiskPressureStatus } from "../../daemon/disk-pressure-guard.js";
import { classifyDiskPressureTurnPolicy } from "../../daemon/disk-pressure-policy.js";
import { processMessage } from "../../daemon/process-message.js";
import {
  mapChatTypeToConversationType,
  type TrustContext,
} from "../../daemon/trust-context.js";
import { HeartbeatService } from "../../heartbeat/heartbeat-service.js";
import type { Message as ProviderMessage } from "../../messaging/provider-types.js";
import {
  resolveSlackBotUserId,
  withSlackBotToken,
} from "../../messaging/providers/slack/adapter.js";
import {
  backfillDm,
  backfillThreadWindowPage,
  type SlackBackfillWindowPage,
} from "../../messaging/providers/slack/backfill.js";
import { downloadSlackFile } from "../../messaging/providers/slack/download.js";
import {
  buildSlackTimezoneMetadata,
  formatSlackTimezoneLabel,
  mergeSlackMetadata,
  readSlackMetadataFromMessageMetadata,
  type SlackFileMetadata,
  type SlackMessageMetadata,
  writeSlackMetadata,
} from "../../messaging/providers/slack/message-metadata.js";
import { MESSAGE_PREVIEW_MAX_LENGTH } from "../../notifications/notification-utils.js";
import {
  attachInlineAttachmentToMessage,
  AttachmentUploadError,
  getAttachmentsByIds,
  validateAttachmentUpload,
} from "../../persistence/attachments-store.js";
import {
  recordConversationSeenSignal,
  type SignalType,
} from "../../persistence/conversation-attention-store.js";
import {
  addMessage,
  getMessageById,
  getMessages,
  selectSlackMetaCandidateMetadata,
  updateMessageContent,
  updateMessageMetadata,
} from "../../persistence/conversation-crud.js";
import {
  clearPayload,
  findMessageBySourceId,
  recordInbound,
} from "../../persistence/delivery-crud.js";
import { markProcessed } from "../../persistence/delivery-status.js";
import { upsertBinding } from "../../persistence/external-conversation-store.js";
import type { ContentBlock } from "../../providers/types.js";
import { wrapUntrustedContent } from "../../security/untrusted-content.js";
import { canonicalizeInboundIdentity } from "../../util/canonicalize-identity.js";
import { getLogger } from "../../util/logger.js";
import { truncate } from "../../util/truncate.js";
import {
  isApprovalHandshakeInProgress,
  notifyGuardianOfAccessRequest,
} from "../access-request-helper.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { deliverChannelReply } from "../gateway-client.js";
import { trustContextFromVerdict } from "../trust-verdict-consumer.js";
import { canonicalChannelAssistantId } from "./channel-route-shared.js";
import { BadRequestError } from "./errors.js";
import { handleApprovalInterception } from "./guardian-approval-interception.js";
import {
  composeAccessDenialReply,
  enforceIngressAcl,
} from "./inbound-stages/acl-enforcement.js";
import { enforceAdmissionPolicy } from "./inbound-stages/admission-policy.js";
import { processChannelMessageInBackground } from "./inbound-stages/background-dispatch.js";
import { handleBootstrapIntercept } from "./inbound-stages/bootstrap-intercept.js";
import { handleEditIntercept } from "./inbound-stages/edit-intercept.js";
import { handleEscalationIntercept } from "./inbound-stages/escalation-intercept.js";
import { handleGuardianActivationIntercept } from "./inbound-stages/guardian-activation-intercept.js";
import { handleGuardianReplyIntercept } from "./inbound-stages/guardian-reply-intercept.js";
import {
  handleSlackReactionIntercept,
  isSlackReactionEvent,
} from "./inbound-stages/reaction-intercept.js";
import { runSecretIngressCheck } from "./inbound-stages/secret-ingress-check.js";
import { tryTranscribeAudioAttachments } from "./inbound-stages/transcribe-audio.js";
import type { RouteHandlerArgs } from "./types.js";

const log = getLogger("runtime-http");

// Gates the per-channel admission floor stage. When off, the floor is never
// enforced and inbound falls back to ACL-only behavior (the gateway also skips
// attaching a floor when off, so the ACL sees the default permissive policy).
const CHANNEL_TRUST_FLOORS_FLAG = "channel-trust-floors" as const;

const DISK_PRESSURE_REMOTE_BLOCK_REPLY =
  "Storage is critically low, so remote messages are ignored until the guardian frees enough space. Please try again later.";

// Delete-lookup retry configuration. Delete webhooks can race ahead of
// the inbound handler's `linkMessage` call when the original message's
// agent loop is still running. Retrying buys time for the link to land
// before we drop the deletion signal. Mirrors the edit-intercept path's
// EDIT_LOOKUP_RETRIES / EDIT_LOOKUP_DELAY_MS constants.
let deleteLookupRetries = 5;
let deleteLookupDelayMs = 2000;

interface SlackActorTimezoneMetadata {
  timezone?: string;
  timezoneLabel?: string;
  timezoneOffsetSeconds?: number;
}

function trimMetadataString(
  metadata: Record<string, unknown> | undefined,
  key: string,
): string | undefined {
  const value = metadata?.[key];
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

function parseSlackActorTimezoneMetadata(
  sourceChannel: string,
  metadata: SourceMetadata | undefined,
): SlackActorTimezoneMetadata | undefined {
  if (sourceChannel !== "slack") return undefined;

  const timezone = metadata?.timezone?.trim() || undefined;
  const timezoneLabel = metadata?.timezoneLabel?.trim() || undefined;
  const timezoneOffsetSeconds =
    metadata?.timezoneOffsetSeconds != null &&
    Number.isFinite(metadata.timezoneOffsetSeconds)
      ? metadata.timezoneOffsetSeconds
      : undefined;

  if (
    timezone === undefined &&
    timezoneLabel === undefined &&
    timezoneOffsetSeconds === undefined
  ) {
    return undefined;
  }

  return {
    ...(timezone ? { timezone } : {}),
    ...(timezoneLabel ? { timezoneLabel } : {}),
    ...(timezoneOffsetSeconds !== undefined ? { timezoneOffsetSeconds } : {}),
  };
}

function attachSlackRequesterTimezone(
  trustCtx: TrustContext,
  timezone: SlackActorTimezoneMetadata | undefined,
): TrustContext {
  if (!timezone) return trustCtx;
  return {
    ...trustCtx,
    ...(timezone.timezone ? { requesterTimezone: timezone.timezone } : {}),
    ...(timezone.timezoneLabel
      ? { requesterTimezoneLabel: timezone.timezoneLabel }
      : {}),
    ...(timezone.timezoneOffsetSeconds !== undefined
      ? { requesterTimezoneOffsetSeconds: timezone.timezoneOffsetSeconds }
      : {}),
  };
}

function resolveSlackTranscriptTimestampTimezone(
  clientTimezone?: string | null,
): {
  timestampTimezone: string;
  timestampTimezoneLabel?: string;
} {
  const config = getConfig();
  const timestampTimezone = resolveTurnTimezoneContext({
    configuredUserTimeZone: config.ui?.userTimezone ?? null,
    clientTimezone: clientTimezone ?? null,
    detectedTimezone: config.ui?.detectedTimezone ?? null,
    hostTimeZone: Intl.DateTimeFormat().resolvedOptions().timeZone,
  }).effectiveTimezone;
  const timestampTimezoneLabel = formatSlackTimezoneLabel(timestampTimezone);
  return {
    timestampTimezone,
    ...(timestampTimezoneLabel ? { timestampTimezoneLabel } : {}),
  };
}

function resolveInboundClientTimezone(params: {
  bodyClientTimezone?: unknown;
  sourceMetadata?: SourceMetadata;
  conversationId: string;
}): string | undefined {
  const bodyClientTimezone =
    typeof params.bodyClientTimezone === "string"
      ? canonicalizeTimeZone(params.bodyClientTimezone)
      : undefined;
  const metadataClientTimezone = params.sourceMetadata?.clientTimezone
    ? canonicalizeTimeZone(params.sourceMetadata.clientTimezone)
    : undefined;
  return (
    bodyClientTimezone ??
    metadataClientTimezone ??
    findConversation(params.conversationId)?.clientTimezone
  );
}

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
    sourceMetadata?: SourceMetadata;
    replyCallbackUrl?: string;
    callbackQueryId?: string;
    callbackData?: string;
    clientTimezone?: unknown;
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
  const slackChannelName =
    sourceChannel === "slack" && typeof sourceMetadata?.channelName === "string"
      ? sourceMetadata.channelName.trim() || null
      : null;
  const slackActorTimezone = parseSlackActorTimezoneMetadata(
    sourceChannel,
    sourceMetadata,
  );

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

  // ── Slack reaction handling ──
  // Reactions are passive channel signals — not messages, and not access
  // attempts. Dispatch them to a dedicated interceptor BEFORE the message
  // pipeline (ACL, admission floor, disk-pressure, conversation binding) so a
  // 👍 never triggers a verification handshake or an access-request
  // notification, and a stranger's reaction creates no conversation/binding.
  // The interceptor drops strangers, records known contacts' reactions as
  // transcript signals, and routes a guardian's reaction on an approval card
  // through the canonical guardian decision pipeline. Reactions never drive an
  // agent turn.
  if (isSlackReactionEvent(body)) {
    return handleSlackReactionIntercept({
      callbackData: body.callbackData!,
      sourceChannel,
      sourceInterface,
      conversationExternalId,
      externalMessageId,
      canonicalAssistantId,
      rawSenderId,
      canonicalSenderId,
      actorDisplayName: body.actorDisplayName,
      actorUsername: body.actorUsername,
      replyCallbackUrl: body.replyCallbackUrl,
      sourceMetadata: body.sourceMetadata,
      slackChannelName,
      approvalConversationGenerator,
    });
  }

  // ── Admission policy pre-computation ──
  // Resolve the effective policy before ACL so it can skip its hard-deny
  // paths for permissive policies (`strangers`, `any_contact`). The same
  // value is reused by the floor stage below, which is gated on
  // `channel-trust-floors`.
  const channelTrustFloorsEnabled = isAssistantFeatureFlagEnabled(
    CHANNEL_TRUST_FLOORS_FLAG,
    getConfig(),
  );
  const admissionPolicyFromGateway = isAdmissionPolicy(
    sourceMetadata?.admissionPolicy,
  )
    ? (sourceMetadata!.admissionPolicy as AdmissionPolicy)
    : ADMISSION_POLICY_DEFAULT;
  // Pass `undefined` to the ACL when the feature is off so it takes none of
  // its policy-aware bypasses (the floor stage is skipped too). This keeps the
  // flag-off path on the pre-feature ACL behavior and prevents a bypass from
  // routing to a disabled floor stage and admitting unconditionally.
  const effectiveAdmissionPolicyForAcl = channelTrustFloorsEnabled
    ? admissionPolicyFromGateway
    : undefined;

  // Callback payloads (button presses, delete sentinels) are decision
  // attempts / lifecycle events, not access attempts: the ACL stage must not
  // respond to one by minting a verification challenge or creating an access
  // request (LUM-2673). Reaction callbacks never reach this point — the
  // intercept above returns for them.
  const isCallbackInteraction = hasCallbackData;

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
    effectiveAdmissionPolicy: effectiveAdmissionPolicyForAcl,
    isCallbackInteraction,
  });
  if (aclResult.earlyResponse) return aclResult.earlyResponse;
  const { resolvedMember } = aclResult;

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
      // "no_audio" — no action needed
    }
  }

  const sourceMessageId =
    typeof sourceMetadata?.messageId === "string"
      ? sourceMetadata.messageId
      : undefined;
  const slackThreadTs =
    sourceChannel === "slack" &&
    typeof sourceMetadata?.threadId === "string" &&
    sourceMetadata.threadId.trim().length > 0
      ? sourceMetadata.threadId.trim()
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
      sourceThreadId: slackThreadTs,
      canonicalAssistantId,
      assistantId,
      content,
      channelId: resolvedMember?.channelId,
    });
  }

  // ── New message path ──
  const result = recordInbound(
    sourceChannel,
    conversationExternalId,
    externalMessageId,
    {
      sourceMessageId,
      assistantId: canonicalAssistantId,
      sourceThreadId: slackThreadTs,
    },
  );

  const replyCallbackUrl = body.replyCallbackUrl;

  // external_conversation_bindings is assistant-agnostic. Restrict writes to
  // self so assistant-scoped legacy routes do not overwrite each other's
  // channel binding metadata for the same chat.
  if (canonicalAssistantId === DAEMON_INTERNAL_ASSISTANT_ID) {
    upsertBinding({
      conversationId: result.conversationId,
      sourceChannel,
      externalChatId: conversationExternalId,
      externalChatName: slackChannelName,
      externalThreadId: slackThreadTs ?? null,
      externalUserId: canonicalSenderId ?? rawSenderId ?? null,
      displayName: body.actorDisplayName ?? null,
      username: body.actorUsername ?? null,
    });
  }

  // ── Actor role resolution ──
  // Built from the gateway-stamped trust verdict (ACL + identity). An absent
  // verdict is already hard-denied upstream in enforceIngressAcl; the synthetic
  // unknown ctx here only guards non-ACL metadata use on that unreachable path.
  const inboundVerdict = sourceMetadata?.trustVerdict;
  const trustCtx: TrustContext = attachSlackRequesterTimezone(
    inboundVerdict
      ? trustContextFromVerdict(inboundVerdict, {
          sourceChannel,
          conversationExternalId,
          actorUsername: body.actorUsername,
          actorDisplayName: body.actorDisplayName,
        })
      : {
          sourceChannel,
          trustClass: "unknown",
          requesterExternalUserId: canonicalSenderId ?? undefined,
          requesterChatId: conversationExternalId,
        },
    slackActorTimezone,
  );

  // ── Admission policy floor ──
  // Sits between trust resolution and the agent loop. The gateway attaches
  // the per-channel-type floor (`sourceMetadata.admissionPolicy`); the
  // runtime evaluates `trustClass ≥ floor`. Denials reuse the same
  // canned-reply / guardian-notify side effects as `not_a_member` (no
  // re-verification challenge — §8.2). The gateway kill switch already
  // dropped `no_one` upstream, but the stage handles it defensively.
  //
  // Internal channels (`vellum`, `platform`, `a2a`) short-circuit admit
  // inside `enforceAdmissionPolicy` — defense in depth alongside the
  // gateway's exempt-channel skip and the PUT-handler's 403.
  //
  // Bootstrap deep-link: when ACL resolved a validated pending_bootstrap
  // session, skip the floor entirely. The bootstrap intercept stage below
  // reuses that session (no second gateway lookup), handles identity
  // binding, and emits its own reply; the sender has not yet acquired a
  // trust class and should not be denied here.
  // Gated by `channel-trust-floors`: when off, skip the floor entirely (admit)
  // so inbound falls back to ACL-only behavior. The gateway also omits the
  // floor when off, so the ACL above already saw the default permissive policy.
  const admissionResult =
    !channelTrustFloorsEnabled || aclResult.validatedBootstrapSession != null
      ? ({ admitted: true } as const)
      : enforceAdmissionPolicy({
          sourceChannel,
          trustClass: trustCtx.trustClass,
          memberStatus: resolvedMember?.status,
          policy: admissionPolicyFromGateway,
        });
  if (!admissionResult.admitted) {
    log.info(
      {
        sourceChannel,
        conversationExternalId,
        eventId: result.eventId,
        trustClass: trustCtx.trustClass,
        reason: admissionResult.reason,
        effectivePolicy: admissionResult.effectivePolicy,
        shouldChallenge: admissionResult.shouldChallenge,
      },
      "Inbound admission policy floor denied",
    );

    // §8.2 + webhook idempotency: skip guardian-notify + reply side
    // effects on duplicate deliveries (matches the disk-pressure branch
    // below at line ~810). Without this guard, a webhook retry of the
    // same duplicated event that hit the floor re-fires the access
    // request notification and the canned denial reply — visible to the
    // guardian/sender without a re-evaluation.
    if (result.duplicate) {
      return {
        accepted: true,
        duplicate: result.duplicate,
        eventId: result.eventId,
        denied: true,
        reason: admissionResult.reason,
      };
    }

    // Notify the guardian about the access attempt — same surface as
    // `acl-enforcement.ts:267-449` for `not_a_member`, so denials are
    // visible in the same UI. previousMemberStatus is only meaningful when
    // a member record exists; we pass it through when available so the
    // guardian sees "previously pending" etc. Callback interactions never
    // create an access request (LUM-2673); the handshake window is still
    // probed for reply copy.
    let guardianNotified = false;
    let handshakeInProgress = false;
    const floorSenderId = canonicalSenderId ?? rawSenderId;
    if (isCallbackInteraction) {
      if (floorSenderId) {
        handshakeInProgress = isApprovalHandshakeInProgress({
          canonicalAssistantId,
          sourceChannel,
          actorExternalId: floorSenderId,
        });
      }
    } else {
      try {
        const accessResult = await notifyGuardianOfAccessRequest({
          canonicalAssistantId,
          sourceChannel,
          conversationExternalId,
          actorExternalId: floorSenderId,
          actorDisplayName: body.actorDisplayName,
          actorUsername: body.actorUsername,
          ...(resolvedMember
            ? {
                previousMemberStatus: channelStatusToMemberStatus(
                  resolvedMember.status,
                ),
              }
            : {}),
          messagePreview: truncate(trimmedContent, MESSAGE_PREVIEW_MAX_LENGTH),
          ...(typeof sourceMetadata?.isStranger === "boolean"
            ? { isStranger: sourceMetadata.isStranger }
            : {}),
          ...(typeof sourceMetadata?.isRestricted === "boolean"
            ? { isRestricted: sourceMetadata.isRestricted }
            : {}),
          ...(typeof sourceMetadata?.messageId === "string"
            ? { messageTs: sourceMetadata.messageId }
            : {}),
        });
        guardianNotified = accessResult.notified;
        handshakeInProgress =
          !accessResult.notified &&
          accessResult.reason === "approval_pending_verification";
      } catch (err) {
        log.error(
          { err, sourceChannel, conversationExternalId },
          "Failed to notify guardian of access request (admission policy)",
        );
      }
    }

    // Canned reply mirrors the not_a_member surface. §8.2: no upgrade
    // challenge text for `trusted_contacts` / `guardian_only` denials —
    // sender gets the standard "ask the guardian" copy.
    const replyText = await composeAccessDenialReply({
      sourceChannel,
      guardianNotified,
      handshakeInProgress,
    });
    let replyDelivered = false;
    if (replyCallbackUrl) {
      const replyPayload: Parameters<typeof deliverChannelReply>[1] = {
        chatId: conversationExternalId,
        text: replyText,
        assistantId: canonicalAssistantId,
      };
      if (sourceChannel === "slack" && (canonicalSenderId ?? rawSenderId)) {
        replyPayload.ephemeral = true;
        replyPayload.user = (canonicalSenderId ?? rawSenderId)!;
      }
      try {
        await deliverChannelReply(replyCallbackUrl, replyPayload);
        replyDelivered = true;
      } catch (err) {
        log.error(
          { err, conversationExternalId },
          "Failed to deliver admission policy denial reply",
        );
      }
    }

    if (!result.duplicate) markProcessed(result.eventId);

    return {
      accepted: true,
      duplicate: result.duplicate,
      eventId: result.eventId,
      denied: true,
      reason: admissionResult.reason,
      ...(!replyDelivered && { replyText }),
    };
  }

  const diskPressureDecision = classifyDiskPressureTurnPolicy(
    getDiskPressureStatus(),
    {
      sourceChannel,
      sourceInterface,
      trustContext: {
        sourceChannel: trustCtx.sourceChannel,
        trustClass: trustCtx.trustClass,
      },
    },
  );
  if (diskPressureDecision.action === "block") {
    if (!result.duplicate) {
      clearPayload(result.eventId);
      markProcessed(result.eventId);
    }
    log.info(
      {
        conversationId: result.conversationId,
        eventId: result.eventId,
        duplicate: result.duplicate,
        reason: diskPressureDecision.reason,
        trustClass: trustCtx.trustClass,
      },
      "Channel inbound blocked during disk pressure cleanup mode",
    );

    if (replyCallbackUrl && !result.duplicate) {
      const replyPayload: Parameters<typeof deliverChannelReply>[1] = {
        chatId: conversationExternalId,
        text: DISK_PRESSURE_REMOTE_BLOCK_REPLY,
        assistantId: canonicalAssistantId,
      };
      if (sourceChannel === "slack" && (canonicalSenderId ?? rawSenderId)) {
        replyPayload.ephemeral = true;
        replyPayload.user = (canonicalSenderId ?? rawSenderId)!;
      }
      try {
        await deliverChannelReply(replyCallbackUrl, replyPayload);
      } catch (err) {
        log.warn(
          {
            err,
            conversationId: result.conversationId,
            eventId: result.eventId,
          },
          "Failed to deliver disk pressure block reply",
        );
      }
    }

    return {
      accepted: true,
      duplicate: result.duplicate,
      eventId: result.eventId,
      diskPressure: "blocked",
      reason: diskPressureDecision.reason,
    };
  }

  // ── Ingress escalation ──
  const escalationResponse = await handleEscalationIntercept({
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
  trustCtx.conversationType = mapChatTypeToConversationType(sourceChatType);

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
    validatedBootstrapSession: aclResult.validatedBootstrapSession,
  });
  if (bootstrapResponse) return bootstrapResponse;

  // Legacy voice guardian action interception removed — all guardian reply
  // routing now flows through the canonical router below (routeGuardianReply),
  // which handles request code matching, callback parsing, and NL classification
  // against canonical_guardian_requests.

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
      const slackSpeakerTimezoneLabel =
        trustCtx.trustClass !== "guardian"
          ? slackActorTimezone?.timezoneLabel
          : undefined;
      const inboundClientTimezone = resolveInboundClientTimezone({
        bodyClientTimezone: body.clientTimezone,
        sourceMetadata,
        conversationId: result.conversationId,
      });
      const slackTranscriptTimestampTimezone =
        sourceChannel === "slack"
          ? resolveSlackTranscriptTimestampTimezone(inboundClientTimezone)
          : undefined;
      const slackActorTeamId =
        sourceChannel === "slack" &&
        typeof sourceMetadata?.actorTeamId === "string" &&
        sourceMetadata.actorTeamId.length > 0
          ? sourceMetadata.actorTeamId
          : undefined;
      const slackInbound =
        sourceChannel === "slack"
          ? {
              channelId: conversationExternalId,
              ...(slackChannelName ? { channelName: slackChannelName } : {}),
              channelTs: sourceMessageId ?? externalMessageId,
              ...(slackThreadTs ? { threadTs: slackThreadTs } : {}),
              ...((body.actorDisplayName ?? body.actorUsername)
                ? {
                    displayName: body.actorDisplayName ?? body.actorUsername!,
                  }
                : {}),
              ...(trustCtx.requesterExternalUserId
                ? { actorExternalUserId: trustCtx.requesterExternalUserId }
                : {}),
              ...(slackActorTeamId ? { actorTeamId: slackActorTeamId } : {}),
              ...buildSlackTimezoneMetadata({
                actorTimezone: slackActorTimezone?.timezone,
                actorTimezoneLabel: slackActorTimezone?.timezoneLabel,
                actorTimezoneOffsetSeconds:
                  slackActorTimezone?.timezoneOffsetSeconds,
                timestampTimezone:
                  slackTranscriptTimestampTimezone?.timestampTimezone,
                timestampTimezoneLabel:
                  slackTranscriptTimestampTimezone?.timestampTimezoneLabel,
                speakerTimezoneLabel: slackSpeakerTimezoneLabel,
              }),
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
      const slackBotMentioned =
        sourceChannel === "slack" && sourceMetadata?.slackBotMentioned === true;

      // ── DM cold-start backfill ──
      // First time a Slack DM without thread_ts lands in a conversation that
      // has fewer than SLACK_DM_BACKFILL_WARM_THRESHOLD stored slackMeta
      // messages, fetch a window of recent history so the agent sees prior
      // context. Threaded Slack DMs use the thread gap/delta path below so
      // separate app conversations do not pull unrelated whole-DM history.
      if (
        sourceChannel === "slack" &&
        sourceChatType === "im" &&
        !slackThreadTs
      ) {
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
          guardianExternalUserId: trustCtx.guardianExternalUserId,
          latestTs: boundingTs,
        });
      }

      // ── Thread gap/delta backfill ──
      // When a Slack thread reply arrives, including app/agent DMs that carry
      // thread_ts, compare the stored thread state with the inbound message's
      // ts and fetch only the bounded unseen window. Initial late-join turns
      // hydrate the earliest thread messages plus a recent window adjacent to
      // the inbound reply; later turns use a delta window after the latest
      // stored thread ts and before the inbound ts. Awaited (mirrors the DM
      // cold-start path above) so the agent loop dispatched immediately
      // afterwards observes hydrated context. Failures are swallowed inside
      // the helper so they never block dispatch.
      if (slackThreadTs) {
        await triggerSlackThreadBackfillIfNeeded({
          conversationId: result.conversationId,
          channelId: conversationExternalId,
          threadTs: slackThreadTs,
          excludeChannelTs: slackInbound?.channelTs,
          account: slackAccount,
          guardianExternalUserId: trustCtx.guardianExternalUserId,
        });
      }

      // Wrap non-guardian inbound content in external_content boundaries so
      // the model can distinguish external channel messages from instructions.
      const contentForProcessing =
        trustCtx.trustClass !== "guardian"
          ? wrapUntrustedContent(trimmedContent, {
              source: sourceChannel === "slack" ? "slack" : "webhook",
              sourceDetail: trustCtx.requesterIdentifier,
            })
          : trimmedContent;
      const displayContentForProcessing =
        sourceChannel === "slack" && trustCtx.trustClass !== "guardian"
          ? trimmedContent
          : undefined;

      // Fire-and-forget: process the message and deliver the reply in the background.
      // The HTTP response returns immediately so the gateway webhook is not blocked.
      // The onEvent callback in processMessage registers pending interactions, and
      // approval interception (above) handles decisions via the pending-interactions tracker.
      processChannelMessageInBackground({
        processMessage,
        conversationId: result.conversationId,
        eventId: result.eventId,
        content: contentForProcessing,
        displayContent: displayContentForProcessing,
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
        assistantId: canonicalAssistantId,
        approvalCopyGenerator,
        chatType: sourceChatType,
        clientTimezone: inboundClientTimezone,
        slackBotMentioned,
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
 * (DM cold-start backfill, thread gap/delta backfill, etc.). Backfilled Slack
 * rows normally persist as `user` history, but rows authored by this
 * assistant's configured Slack bot are replayed as assistant history so prior
 * assistant messages do not enter model context wrapped as external user
 * content.
 * Caller is responsible for dedup checks before invoking; this helper
 * performs no idempotency check itself.
 */
async function persistBackfilledSlackMessage(params: {
  conversationId: string;
  channelId: string;
  message: ProviderMessage;
  account?: string;
  guardianExternalUserId?: string;
}): Promise<void> {
  const { message } = params;
  const slackFilesWithUrls = readSlackFilesWithUrlsFromProviderMetadata(
    message.metadata,
  );
  // Persisted shape strips the transient URL fields; only `{ id, name,
  // mimetype }` is allowed by `slackFileMetadataSchema`.
  const slackFiles: SlackFileMetadata[] = slackFilesWithUrls.map((f) => ({
    ...(f.id ? { id: f.id } : {}),
    name: f.name,
    ...(f.mimetype ? { mimetype: f.mimetype } : {}),
  }));
  const actorExternalUserId = message.sender?.id?.trim();
  const actorTimezone = trimMetadataString(message.metadata, "actorTimezone");
  const actorTimezoneLabel = trimMetadataString(
    message.metadata,
    "actorTimezoneLabel",
  );
  const isGuardian = isBackfilledSlackGuardianMessage(
    message,
    params.guardianExternalUserId,
  );
  const slackTranscriptTimestampTimezone =
    resolveSlackTranscriptTimestampTimezone();
  const slackMeta: SlackMessageMetadata = {
    source: "slack",
    channelId: params.channelId,
    channelTs: message.id,
    eventKind: "message",
    ...(message.threadId ? { threadTs: message.threadId } : {}),
    ...(message.sender?.name ? { displayName: message.sender.name } : {}),
    ...(actorExternalUserId ? { actorExternalUserId } : {}),
    ...buildSlackTimezoneMetadata({
      actorTimezone,
      actorTimezoneLabel,
      actorTimezoneOffsetSeconds: message.metadata?.actorTimezoneOffsetSeconds,
      timestampTimezone: slackTranscriptTimestampTimezone?.timestampTimezone,
      timestampTimezoneLabel:
        slackTranscriptTimestampTimezone?.timestampTimezoneLabel,
      speakerTimezoneLabel: isGuardian ? undefined : actorTimezoneLabel,
    }),
    ...(slackFiles.length > 0 ? { slackFiles } : {}),
  };

  const role = (await isBackfilledSlackAssistantMessage(
    message,
    params.account,
  ))
    ? "assistant"
    : "user";

  const rawText = message.text ?? "";

  const persisted = await addMessage(params.conversationId, role, rawText, {
    metadata: {
      slackMeta: writeSlackMetadata(slackMeta),
      provenanceTrustClass: isGuardian ? "guardian" : "unknown",
      provenanceSourceChannel: "slack",
      ...(params.guardianExternalUserId
        ? { provenanceGuardianExternalUserId: params.guardianExternalUserId }
        : {}),
      ...(actorExternalUserId
        ? { provenanceRequesterIdentifier: actorExternalUserId }
        : {}),
    },
  });

  // Hydrate image attachments inline, then rewrite the saved row to include
  // `type: "image"` content blocks. Slack context assembly reloads from
  // `messages.content`; the attachment link alone is not part of the model
  // transcript. Non-image files keep the marker produced by the Slack renderer.
  const imageFiles = slackFilesWithUrls.filter(
    (f) =>
      (f.urlPrivateDownload || f.urlPrivate) &&
      typeof f.mimetype === "string" &&
      f.mimetype.startsWith("image/"),
  );
  if (imageFiles.length === 0) return;

  const hydratedAttachments = await withSlackBotToken(
    params.account,
    async (token) => {
      const attachments: MessageAttachmentInput[] = [];

      for (let i = 0; i < imageFiles.length; i++) {
        const file = imageFiles[i];
        try {
          const downloaded = await downloadSlackFile(file, token);
          if (!downloaded) continue;
          const validation = validateAttachmentUpload(
            downloaded.filename,
            downloaded.mimeType,
          );
          if (!validation.ok) {
            log.warn(
              {
                filename: downloaded.filename,
                mimeType: downloaded.mimeType,
                error: validation.error,
                channelTs: message.id,
              },
              "Skipping backfilled Slack image: validation failed",
            );
            continue;
          }
          attachInlineAttachmentToMessage(
            persisted.id,
            i,
            downloaded.filename,
            downloaded.mimeType,
            downloaded.data,
            { normalizeImage: true },
          );
          attachments.push({
            filename: downloaded.filename,
            mimeType: downloaded.mimeType,
            data: downloaded.data,
          });
        } catch (err) {
          if (err instanceof AttachmentUploadError) {
            log.warn(
              {
                filename: file.name,
                error: err.message,
                channelTs: message.id,
              },
              "Skipping backfilled Slack image: upload error",
            );
            continue;
          }
          log.warn(
            { err, fileId: file.id, name: file.name, channelTs: message.id },
            "Failed to hydrate backfilled Slack image; proceeding without it",
          );
        }
      }

      return attachments;
    },
  );
  if (hydratedAttachments === null) {
    log.debug(
      { conversationId: params.conversationId, channelTs: message.id },
      "No Slack token available for backfill image hydration; skipping",
    );
    return;
  }

  if (hydratedAttachments.length > 0) {
    updateMessageContent(
      persisted.id,
      JSON.stringify(
        buildBackfilledSlackContentBlocks(rawText, hydratedAttachments),
      ),
    );
  }
}

function buildBackfilledSlackContentBlocks(
  text: string,
  attachments: MessageAttachmentInput[],
): ContentBlock[] {
  const blocks: ContentBlock[] = [];
  if (text.trim().length > 0) {
    blocks.push({ type: "text", text });
  }
  blocks.push(...attachmentsToContentBlocks(attachments));
  return blocks;
}

function isBackfilledSlackGuardianMessage(
  message: ProviderMessage,
  guardianExternalUserId: string | undefined,
): boolean {
  const rawSenderId = message.sender?.id?.trim();
  if (!rawSenderId || !guardianExternalUserId) return false;
  const canonicalSender =
    canonicalizeInboundIdentity("slack", rawSenderId) ?? rawSenderId;
  const canonicalGuardian =
    canonicalizeInboundIdentity("slack", guardianExternalUserId) ??
    guardianExternalUserId.trim();
  return canonicalSender === canonicalGuardian;
}

const SLACK_ASSISTANT_THREAD_PLACEHOLDER_TEXT = "New Assistant Thread";

async function isSlackAssistantThreadPlaceholder(
  message: ProviderMessage,
  account: string | undefined,
): Promise<boolean> {
  if (message.metadata?.isBot !== true) return false;
  const hasSlackFiles =
    Array.isArray(message.metadata.slackFiles) &&
    message.metadata.slackFiles.length > 0;
  return (
    message.text.replace(/\s+/g, " ").trim() ===
      SLACK_ASSISTANT_THREAD_PLACEHOLDER_TEXT &&
    (message.threadId === undefined || message.threadId === message.id) &&
    message.hasAttachments !== true &&
    !hasSlackFiles &&
    (await isBackfilledSlackAssistantMessage(message, account))
  );
}

async function isBackfilledSlackAssistantMessage(
  message: ProviderMessage,
  account: string | undefined,
): Promise<boolean> {
  if (message.metadata?.isBot !== true) return false;

  const botUserId = getConfig().slack.botUserId.trim();
  const rawSenderId = message.sender?.id?.trim();
  if (!botUserId) return false;

  if (rawSenderId && slackIdentityMatches(rawSenderId, botUserId)) return true;

  const rawBotId =
    typeof message.metadata.slackBotId === "string"
      ? message.metadata.slackBotId.trim()
      : "";
  if (!rawBotId) return false;

  try {
    const resolvedBotUserId = await resolveSlackBotUserId(account, rawBotId);
    return (
      typeof resolvedBotUserId === "string" &&
      slackIdentityMatches(resolvedBotUserId, botUserId)
    );
  } catch (err) {
    log.warn(
      { err, slackBotId: rawBotId, channelTs: message.id },
      "Failed to resolve Slack bot id for backfilled assistant detection",
    );
    return false;
  }
}

function slackIdentityMatches(left: string, right: string): boolean {
  const canonicalSender =
    canonicalizeInboundIdentity("slack", left) ?? left.trim();
  const canonicalBot =
    canonicalizeInboundIdentity("slack", right) ?? right.trim();
  return canonicalSender === canonicalBot;
}

/**
 * Transient view of `slackFiles` that preserves the download URLs added by
 * `mapSlackFiles` on the in-flight `ProviderMessage`. These URLs never reach
 * persisted storage — see `slackFileMetadataSchema`. The backfill image
 * hydration path is the only consumer; URLs are absent from persisted rows.
 */
interface SlackFileWithUrls extends SlackFileMetadata {
  urlPrivateDownload?: string;
  urlPrivate?: string;
}

function readSlackFilesWithUrlsFromProviderMetadata(
  metadata: Record<string, unknown> | undefined,
): SlackFileWithUrls[] {
  const raw = metadata?.slackFiles;
  if (!Array.isArray(raw)) return [];
  const files: SlackFileWithUrls[] = [];
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
      ...(typeof record.urlPrivateDownload === "string" &&
      record.urlPrivateDownload.length > 0
        ? { urlPrivateDownload: record.urlPrivateDownload }
        : {}),
      ...(typeof record.urlPrivate === "string" && record.urlPrivate.length > 0
        ? { urlPrivate: record.urlPrivate }
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
  guardianExternalUserId?: string;
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
  guardianExternalUserId?: string;
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
      if (await isSlackAssistantThreadPlaceholder(message, params.account)) {
        continue;
      }
      try {
        await persistBackfilledSlackMessage({
          conversationId: params.conversationId,
          channelId: params.channelId,
          message,
          ...(params.account ? { account: params.account } : {}),
          ...(params.guardianExternalUserId
            ? { guardianExternalUserId: params.guardianExternalUserId }
            : {}),
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
  /**
   * Canonical Slack user ID for the guardian, when a verified Slack guardian
   * binding exists. Backfilled messages from this sender are trusted history
   * and should not be wrapped as external content.
   */
  guardianExternalUserId?: string;
}): Promise<SlackThreadBackfillResult> {
  const {
    conversationId,
    channelId,
    threadTs,
    excludeChannelTs,
    account,
    guardianExternalUserId,
  } = params;

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
      if (await isSlackAssistantThreadPlaceholder(message, account)) {
        continue;
      }
      try {
        await persistBackfilledSlackMessage({
          conversationId,
          channelId,
          message,
          ...(account ? { account } : {}),
          ...(guardianExternalUserId ? { guardianExternalUserId } : {}),
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
