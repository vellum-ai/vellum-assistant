/**
 * Shared access-request creation and notification helper.
 *
 * Encapsulates the "create/dedupe canonical access request + emit notification"
 * logic so both text-channel and voice-channel ingress paths use identical
 * guardian notification flows.
 *
 * Access requests are a special case: they always create a canonical request
 * and emit a notification signal, even when no same-channel guardian binding
 * exists. Guardian identity resolution is anchored on the assistant's vellum
 * principal so access requests cannot bind to stale/cross-assistant contacts.
 */

import type { ChannelId } from "../channels/types.js";
import {
  createCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
} from "../contacts/canonical-guardian-store.js";
import { getGuardianDelivery } from "../contacts/guardian-delivery-reader.js";
import type { ChannelStatus } from "../contacts/types.js";
import {
  recordApprovalCardDelivery,
  recordGuardianRequestDeliveries,
} from "../notifications/canonical-delivery-recorder.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import type { GuardianResolutionSource } from "../notifications/signal.js";
import { getLogger } from "../util/logger.js";
import { resolveAnchoredGuardian } from "./anchored-guardian.js";
import { GUARDIAN_APPROVAL_TTL_MS } from "./routes/channel-route-shared.js";

const log = getLogger("access-request-helper");

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccessRequestParams {
  canonicalAssistantId: string;
  sourceChannel: ChannelId;
  conversationExternalId: string;
  actorExternalId?: string;
  actorDisplayName?: string;
  actorUsername?: string;
  previousMemberStatus?: Exclude<ChannelStatus, "unverified">;
  /** Preview of the requester's original message, shown to the guardian. */
  messagePreview?: string;
  /** Slack-specific: user is from an external workspace (Slack Connect). */
  isStranger?: boolean;
  /** Slack-specific: user is a guest / restricted account. */
  isRestricted?: boolean;
  /** Slack message timestamp for permalink construction. */
  messageTs?: string;
}

export type AccessRequestResult =
  | { notified: true; created: boolean; requestId: string }
  | { notified: false; reason: "no_sender_id" | "already_denied" };

// ---------------------------------------------------------------------------
// Terminal-deny lookup
// ---------------------------------------------------------------------------

/**
 * Assistant-scoped conversation id for an actor's access requests. Stable key
 * that dedupes pending prompts and detects a prior terminal deny for the same
 * (assistant, channel, actor).
 */
export function accessRequestConversationId(
  canonicalAssistantId: string,
  sourceChannel: string,
  actorExternalId: string,
): string {
  return `access-req-${canonicalAssistantId}-${sourceChannel}-${actorExternalId}`;
}

/**
 * Whether the guardian has already terminally denied an access request from
 * this actor on this channel. Callers use it to suppress re-engagement — both
 * the guardian prompt and the self-verify challenge — for a sender the guardian
 * explicitly rejected. Reads the retained `denied` canonical request scoped by
 * the assistant-scoped conversation id.
 */
export function isAccessRequestDenied(params: {
  canonicalAssistantId: string;
  sourceChannel: string;
  actorExternalId: string;
}): boolean {
  const conversationId = accessRequestConversationId(
    params.canonicalAssistantId,
    params.sourceChannel,
    params.actorExternalId,
  );
  return (
    listCanonicalGuardianRequests({
      status: "denied",
      requesterExternalUserId: params.actorExternalId,
      sourceChannel: params.sourceChannel,
      kind: "access_request",
      conversationId,
    }).length > 0
  );
}

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Create/dedupe a canonical access request and emit a notification signal
 * so the guardian can approve or deny the unknown sender.
 *
 * Returns a result indicating whether the guardian was notified and whether
 * a new request was created or an existing one was deduped.
 *
 * Guardian identity resolution uses the assistant's vellum principal as the
 * trust anchor and only accepts source-channel contacts that match it. This
 * prevents stale or cross-assistant contacts from being bound to the request.
 *
 * The canonical store writes complete before this resolves; the notification
 * signal emission is fire-and-forget.
 */
export async function notifyGuardianOfAccessRequest(
  params: AccessRequestParams,
): Promise<AccessRequestResult> {
  const {
    canonicalAssistantId,
    sourceChannel,
    conversationExternalId,
    actorExternalId,
    actorDisplayName,
    actorUsername,
    previousMemberStatus,
    messagePreview,
    isStranger,
    isRestricted,
    messageTs,
  } = params;

  if (!actorExternalId) {
    return { notified: false, reason: "no_sender_id" };
  }

  // Resolve guardian identity with the assistant-anchored strategy (gateway
  // source-channel match validated against the vellum anchor, else the vellum
  // anchor).
  const anchored = resolveAnchoredGuardian({
    guardians: await getGuardianDelivery(),
    sourceChannel,
  });
  const guardianExternalUserId = anchored?.address ?? null;
  const guardianPrincipalId = anchored?.principalId ?? null;
  const guardianBindingChannel = anchored?.channelType ?? null;
  const guardianResolutionSource: GuardianResolutionSource =
    anchored?.source ?? "none";

  log.debug(
    {
      sourceChannel,
      source: guardianResolutionSource,
      hasGuardianPrincipal: !!guardianPrincipalId,
      guardianBindingChannel,
    },
    "access request guardian resolved",
  );

  // The conversationId is assistant-scoped so the dedupe query below only
  // matches requests for the same assistant. Without this, a pending request
  // from assistant A could be returned for assistant B, allowing the caller
  // to piggyback on A's guardian approval.
  const conversationId = accessRequestConversationId(
    canonicalAssistantId,
    sourceChannel,
    actorExternalId,
  );

  // Deduplicate: skip creation if there is already a pending canonical request
  // for the same requester on this channel *and* assistant. Still return
  // notified: true with the existing request ID so callers know the guardian
  // was already notified.
  const existingCanonical = listCanonicalGuardianRequests({
    status: "pending",
    requesterExternalUserId: actorExternalId,
    sourceChannel,
    kind: "access_request",
    conversationId,
  });
  if (existingCanonical.length > 0) {
    log.debug(
      { sourceChannel, actorExternalId, existingId: existingCanonical[0].id },
      "Skipping duplicate access request notification",
    );
    return {
      notified: true,
      created: false,
      requestId: existingCanonical[0].id,
    };
  }

  // Terminal-deny suppression: once the guardian has denied an access request
  // for this sender on this channel, subsequent inbound must not re-prompt.
  // The denied decision persists the sender as an unverified_contact (see the
  // accessRequestResolver deny path); re-surfacing the same request the
  // guardian already rejected would be noise. The guardian can still verify the
  // contact manually — that path does not go through here.
  if (
    isAccessRequestDenied({
      canonicalAssistantId,
      sourceChannel,
      actorExternalId,
    })
  ) {
    log.debug(
      { sourceChannel, actorExternalId },
      "Suppressing access request notification — guardian already denied this sender",
    );
    return { notified: false, reason: "already_denied" };
  }

  const senderIdentifier = actorDisplayName || actorUsername || actorExternalId;
  const requestId = `access-req-${canonicalAssistantId}-${sourceChannel}-${actorExternalId}-${Date.now()}`;

  const canonicalRequest = createCanonicalGuardianRequest({
    id: requestId,
    kind: "access_request",
    sourceType: "channel",
    sourceChannel,
    conversationId,
    requesterExternalUserId: actorExternalId,
    requesterChatId: conversationExternalId,
    guardianExternalUserId: guardianExternalUserId ?? undefined,
    guardianPrincipalId: guardianPrincipalId ?? undefined,
    toolName: "ingress_access_request",
    questionText: `${senderIdentifier} is requesting access to the assistant`,
    expiresAt: Date.now() + GUARDIAN_APPROVAL_TTL_MS,
  });

  let vellumDeliveryId: string | undefined;
  // When the access request originates from a text channel with
  // notification delivery support (Slack, Telegram) and the guardian was
  // resolved via a verified same-channel contact, route the notification
  // only to that channel to reduce noise. Phone is excluded because it
  // is not a deliverable notification channel.
  // When the guardian was NOT verified on the source channel (e.g. resolved
  // via vellum anchor), route to all channels so the guardian can see
  // the request on desktop/other channels where they ARE verified.
  const TEXT_CHANNELS_WITH_DELIVERY: ReadonlySet<string> = new Set([
    "slack",
    "telegram",
  ]);
  const sameChannelOnly =
    TEXT_CHANNELS_WITH_DELIVERY.has(sourceChannel) &&
    guardianResolutionSource === "source-channel-contact";

  void emitNotificationSignal({
    sourceEventName: "ingress.access_request",
    sourceChannel,
    sourceContextId: `access-req-${sourceChannel}-${actorExternalId}`,
    requiresConversation: true,
    ...(sameChannelOnly ? { routingIntent: "single_channel" as const } : {}),
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestId,
      requestCode: canonicalRequest.requestCode ?? "",
      sourceChannel,
      conversationExternalId,
      actorExternalId,
      actorDisplayName: actorDisplayName ?? null,
      actorUsername: actorUsername ?? null,
      senderIdentifier,
      guardianBindingChannel,
      guardianResolutionSource,
      previousMemberStatus: previousMemberStatus ?? null,
      messagePreview: messagePreview ?? null,
      ...(isStranger !== undefined ? { isStranger } : {}),
      ...(isRestricted !== undefined ? { isRestricted } : {}),
      ...(messageTs ? { messageTs } : {}),
    },
    dedupeKey: `access-request:${canonicalRequest.id}`,
    onConversationCreated: (info) => {
      if (info.sourceEventName !== "ingress.access_request" || vellumDeliveryId)
        return;
      vellumDeliveryId = recordApprovalCardDelivery({
        requestId: canonicalRequest.id,
        channel: "vellum",
        conversationId: info.conversationId,
      })?.id;
    },
  })
    .then((signalResult) => {
      vellumDeliveryId = recordGuardianRequestDeliveries({
        requestId: canonicalRequest.id,
        deliveryResults: signalResult.deliveryResults,
        vellumDeliveryId,
      });

      if (!vellumDeliveryId && !sameChannelOnly) {
        recordApprovalCardDelivery({
          requestId: canonicalRequest.id,
          channel: "vellum",
          status: "failed",
        });
        log.warn(
          { requestId: canonicalRequest.id, reason: signalResult.reason },
          "Notification pipeline did not produce a vellum delivery result for access request",
        );
      }
    })
    .catch((err) => {
      log.error(
        { err, requestId: canonicalRequest.id, sourceChannel, actorExternalId },
        "Failed to persist access request delivery rows from notification pipeline",
      );
    });

  log.info(
    {
      sourceChannel,
      actorExternalId,
      senderIdentifier,
      guardianBindingChannel,
    },
    "Guardian notified of access request",
  );

  return { notified: true, created: true, requestId: canonicalRequest.id };
}
