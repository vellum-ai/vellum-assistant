/**
 * Shared access-request creation and notification helper.
 *
 * Encapsulates the "create/dedupe canonical access request + emit notification"
 * logic so both text-channel and voice-channel ingress paths use identical
 * guardian notification flows.
 *
 * Access requests are a special case: they always create a canonical request
 * and emit a notification signal, even when no same-channel guardian binding
 * exists. Guardian identity resolution uses a contacts-first fallback strategy:
 *   1. Source-channel guardian contact channel.
 *   2. Any active guardian channel (deterministic, most-recently-verified).
 *   3. No guardian identity (trusted/vellum-only resolution path).
 */

import type { ChannelId } from "../channels/types.js";
import {
  findGuardianForChannel,
  listGuardianChannels,
} from "../contacts/contact-store.js";
import type { ChannelStatus } from "../contacts/types.js";
import {
  createCanonicalGuardianDelivery,
  createCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
  updateCanonicalGuardianDelivery,
} from "../memory/canonical-guardian-store.js";
import { emitNotificationSignal } from "../notifications/emit-signal.js";
import type { NotificationSourceChannel } from "../notifications/signal.js";
import type { NotificationDeliveryResult } from "../notifications/types.js";
import { getLogger } from "../util/logger.js";
import { ensureVellumGuardianBinding } from "./guardian-vellum-migration.js";
import { GUARDIAN_APPROVAL_TTL_MS } from "./routes/channel-route-shared.js";

const log = getLogger("access-request-helper");

function applyDeliveryStatus(
  deliveryId: string,
  result: NotificationDeliveryResult,
): void {
  if (result.status === "sent") {
    updateCanonicalGuardianDelivery(deliveryId, { status: "sent" });
    return;
  }
  updateCanonicalGuardianDelivery(deliveryId, { status: "failed" });
}

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
}

export type AccessRequestResult =
  | { notified: true; created: boolean; requestId: string }
  | { notified: false; reason: "no_sender_id" };

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
 * Guardian identity resolution: contacts-first for source channel, then any
 * active guardian channel, then null (notification pipeline handles delivery
 * via trusted/vellum channels when no binding exists).
 *
 * This is intentionally synchronous with respect to the canonical store writes
 * and fire-and-forget for the notification signal emission.
 */
export function notifyGuardianOfAccessRequest(
  params: AccessRequestParams,
): AccessRequestResult {
  const {
    canonicalAssistantId,
    sourceChannel,
    conversationExternalId,
    actorExternalId,
    actorDisplayName,
    actorUsername,
    previousMemberStatus,
  } = params;

  if (!actorExternalId) {
    return { notified: false, reason: "no_sender_id" };
  }

  // Resolve guardian identity with contacts-first strategy:
  // 1. Source-channel guardian contact channel
  // 2. Any active guardian channel (deterministic, most-recently-verified)
  // 3. null (notification pipeline handles delivery via trusted channels)
  let guardianExternalUserId: string | null = null;
  let guardianPrincipalId: string | null = null;
  let guardianBindingChannel: string | null = null;
  let guardianResolutionSource: "contacts" | "contacts-fallback" | "none" =
    "none";

  // Try contacts-first: source channel
  const sourceGuardian = findGuardianForChannel(sourceChannel);
  if (sourceGuardian) {
    guardianExternalUserId = sourceGuardian.channel.externalUserId;
    guardianPrincipalId = sourceGuardian.contact.principalId;
    guardianBindingChannel = sourceGuardian.channel.type;
    guardianResolutionSource = "contacts";
  } else {
    // Try contacts-first: any active guardian channel
    const allGuardianChannels = listGuardianChannels();
    if (allGuardianChannels && allGuardianChannels.channels.length > 0) {
      const fallbackChannel = allGuardianChannels.channels[0];
      guardianExternalUserId = fallbackChannel.externalUserId;
      guardianPrincipalId = allGuardianChannels.contact.principalId;
      guardianBindingChannel = fallbackChannel.type;
      guardianResolutionSource = "contacts-fallback";
      log.debug(
        {
          sourceChannel,
          fallbackChannel: guardianBindingChannel,
          canonicalAssistantId,
        },
        "Using cross-channel guardian contact fallback for access request",
      );
    }
    // If no guardian found via contacts, guardianResolutionSource stays "none"
  }

  // Self-heal: access_request requires a principal. If none found via
  // contacts, bootstrap the vellum binding.
  if (!guardianPrincipalId) {
    log.info(
      { sourceChannel, canonicalAssistantId },
      "No guardian principal for access request — self-healing vellum binding",
    );
    const healedPrincipalId = ensureVellumGuardianBinding(canonicalAssistantId);
    const vellumGuardian = findGuardianForChannel("vellum");
    if (vellumGuardian) {
      guardianExternalUserId =
        vellumGuardian.channel.externalUserId ?? guardianExternalUserId;
      guardianPrincipalId =
        vellumGuardian.contact.principalId ?? healedPrincipalId;
      guardianBindingChannel = guardianBindingChannel ?? "vellum";
    } else {
      guardianPrincipalId = healedPrincipalId;
      guardianBindingChannel = guardianBindingChannel ?? "vellum";
    }
  }

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
  const conversationId = `access-req-${canonicalAssistantId}-${sourceChannel}-${actorExternalId}`;

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
    expiresAt: new Date(Date.now() + GUARDIAN_APPROVAL_TTL_MS).toISOString(),
  });

  let vellumDeliveryId: string | null = null;
  void emitNotificationSignal({
    sourceEventName: "ingress.access_request",
    sourceChannel: sourceChannel as NotificationSourceChannel,
    sourceSessionId: `access-req-${sourceChannel}-${actorExternalId}`,
    attentionHints: {
      requiresAction: true,
      urgency: "high",
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestId,
      requestCode: canonicalRequest.requestCode,
      sourceChannel,
      conversationExternalId,
      actorExternalId,
      actorDisplayName: actorDisplayName ?? null,
      actorUsername: actorUsername ?? null,
      senderIdentifier,
      guardianBindingChannel,
      previousMemberStatus: previousMemberStatus ?? null,
    },
    dedupeKey: `access-request:${canonicalRequest.id}`,
    onThreadCreated: (info) => {
      if (info.sourceEventName !== "ingress.access_request" || vellumDeliveryId)
        return;
      const delivery = createCanonicalGuardianDelivery({
        requestId: canonicalRequest.id,
        destinationChannel: "vellum",
        destinationConversationId: info.conversationId,
      });
      vellumDeliveryId = delivery.id;
    },
  })
    .then((signalResult) => {
      for (const result of signalResult.deliveryResults) {
        if (result.channel === "vellum") {
          if (!vellumDeliveryId) {
            const delivery = createCanonicalGuardianDelivery({
              requestId: canonicalRequest.id,
              destinationChannel: "vellum",
              destinationConversationId: result.conversationId,
            });
            vellumDeliveryId = delivery.id;
          }
          applyDeliveryStatus(vellumDeliveryId, result);
          continue;
        }

        const delivery = createCanonicalGuardianDelivery({
          requestId: canonicalRequest.id,
          destinationChannel: result.channel,
          destinationChatId:
            result.destination.length > 0 ? result.destination : undefined,
        });
        applyDeliveryStatus(delivery.id, result);
      }

      if (!vellumDeliveryId) {
        const fallback = createCanonicalGuardianDelivery({
          requestId: canonicalRequest.id,
          destinationChannel: "vellum",
        });
        updateCanonicalGuardianDelivery(fallback.id, { status: "failed" });
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
