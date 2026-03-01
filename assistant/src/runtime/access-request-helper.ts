/**
 * Shared access-request creation and notification helper.
 *
 * Encapsulates the "create/dedupe canonical access request + emit notification"
 * logic so both text-channel and voice-channel ingress paths use identical
 * guardian notification flows.
 *
 * Access requests are a special case: they always create a canonical request
 * and emit a notification signal, even when no same-channel guardian binding
 * exists. Guardian binding resolution uses a fallback strategy:
 *   1. Source-channel active binding first.
 *   2. Any active binding for the assistant (deterministic, most-recently-verified).
 *   3. No guardian identity (trusted/vellum-only resolution path).
 */

import type { ChannelId } from '../channels/types.js';
import {
  createCanonicalGuardianDelivery,
  createCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
  updateCanonicalGuardianDelivery,
} from '../memory/canonical-guardian-store.js';
import { listActiveBindingsByAssistant } from '../memory/channel-guardian-store.js';
import type { MemberStatus } from '../memory/ingress-member-store.js';
import { emitNotificationSignal } from '../notifications/emit-signal.js';
import type { NotificationDeliveryResult } from '../notifications/types.js';
import { getLogger } from '../util/logger.js';
import { getGuardianBinding } from './channel-guardian-service.js';
import { ensureVellumGuardianBinding } from './guardian-vellum-migration.js';
import { GUARDIAN_APPROVAL_TTL_MS } from './routes/channel-route-shared.js';

const log = getLogger('access-request-helper');

function applyDeliveryStatus(deliveryId: string, result: NotificationDeliveryResult): void {
  if (result.status === 'sent') {
    updateCanonicalGuardianDelivery(deliveryId, { status: 'sent' });
    return;
  }
  updateCanonicalGuardianDelivery(deliveryId, { status: 'failed' });
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
  previousMemberStatus?: MemberStatus;
}

export type AccessRequestResult =
  | { notified: true; created: boolean; requestId: string }
  | { notified: false; reason: 'no_sender_id' };

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
 * Guardian binding resolution: source-channel first, then any active binding
 * for the assistant, then null (notification pipeline handles delivery via
 * trusted/vellum channels when no binding exists).
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
    return { notified: false, reason: 'no_sender_id' };
  }

  // Resolve guardian binding with fallback strategy:
  // 1. Source-channel active binding
  // 2. Any active binding for the assistant (deterministic order)
  // 3. null (no guardian identity — notification pipeline uses trusted channels)
  const sourceBinding = getGuardianBinding(canonicalAssistantId, sourceChannel);
  let guardianExternalUserId: string | null = null;
  let guardianPrincipalId: string | null = null;
  let guardianBindingChannel: string | null = null;

  if (sourceBinding) {
    guardianExternalUserId = sourceBinding.guardianExternalUserId;
    guardianPrincipalId = sourceBinding.guardianPrincipalId;
    guardianBindingChannel = sourceBinding.channel;
  } else {
    const allBindings = listActiveBindingsByAssistant(canonicalAssistantId);
    if (allBindings.length > 0) {
      guardianExternalUserId = allBindings[0].guardianExternalUserId;
      guardianPrincipalId = allBindings[0].guardianPrincipalId;
      guardianBindingChannel = allBindings[0].channel;
      log.debug(
        { sourceChannel, fallbackChannel: guardianBindingChannel, canonicalAssistantId },
        'Using cross-channel guardian binding fallback for access request',
      );
    }
  }

  // Self-heal: access_request is now decisionable and requires a principal.
  // If no binding was found (or the binding lacks a principal), bootstrap the
  // vellum binding so the request can be properly attributed.
  if (!guardianPrincipalId) {
    log.info(
      { sourceChannel, canonicalAssistantId },
      'No guardian principal for access request — self-healing vellum binding',
    );
    const healedPrincipalId = ensureVellumGuardianBinding(canonicalAssistantId);
    const vellumBinding = getGuardianBinding(canonicalAssistantId, 'vellum');
    guardianExternalUserId = vellumBinding?.guardianExternalUserId ?? guardianExternalUserId;
    guardianPrincipalId = vellumBinding?.guardianPrincipalId ?? healedPrincipalId;
    guardianBindingChannel = guardianBindingChannel ?? 'vellum';
  }

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
    status: 'pending',
    requesterExternalUserId: actorExternalId,
    sourceChannel,
    kind: 'access_request',
    conversationId,
  });
  if (existingCanonical.length > 0) {
    log.debug(
      { sourceChannel, actorExternalId, existingId: existingCanonical[0].id },
      'Skipping duplicate access request notification',
    );
    return { notified: true, created: false, requestId: existingCanonical[0].id };
  }

  const senderIdentifier = actorDisplayName || actorUsername || actorExternalId;
  const requestId = `access-req-${canonicalAssistantId}-${sourceChannel}-${actorExternalId}-${Date.now()}`;

  const canonicalRequest = createCanonicalGuardianRequest({
    id: requestId,
    kind: 'access_request',
    sourceType: 'channel',
    sourceChannel,
    conversationId,
    requesterExternalUserId: actorExternalId,
    requesterChatId: conversationExternalId,
    guardianExternalUserId: guardianExternalUserId ?? undefined,
    guardianPrincipalId: guardianPrincipalId ?? undefined,
    toolName: 'ingress_access_request',
    questionText: `${senderIdentifier} is requesting access to the assistant`,
    expiresAt: new Date(Date.now() + GUARDIAN_APPROVAL_TTL_MS).toISOString(),
  });

  let vellumDeliveryId: string | null = null;
  void emitNotificationSignal({
    sourceEventName: 'ingress.access_request',
    sourceChannel,
    sourceSessionId: `access-req-${sourceChannel}-${actorExternalId}`,
    assistantId: canonicalAssistantId,
    attentionHints: {
      requiresAction: true,
      urgency: 'high',
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
      if (info.sourceEventName !== 'ingress.access_request' || vellumDeliveryId) return;
      const delivery = createCanonicalGuardianDelivery({
        requestId: canonicalRequest.id,
        destinationChannel: 'vellum',
        destinationConversationId: info.conversationId,
      });
      vellumDeliveryId = delivery.id;
    },
  })
    .then((signalResult) => {
      for (const result of signalResult.deliveryResults) {
        if (result.channel === 'vellum') {
          if (!vellumDeliveryId) {
            const delivery = createCanonicalGuardianDelivery({
              requestId: canonicalRequest.id,
              destinationChannel: 'vellum',
              destinationConversationId: result.conversationId,
            });
            vellumDeliveryId = delivery.id;
          }
          applyDeliveryStatus(vellumDeliveryId, result);
          continue;
        }

        if (result.channel !== 'telegram' && result.channel !== 'sms') {
          continue;
        }

        const delivery = createCanonicalGuardianDelivery({
          requestId: canonicalRequest.id,
          destinationChannel: result.channel,
          destinationChatId: result.destination.length > 0 ? result.destination : undefined,
        });
        applyDeliveryStatus(delivery.id, result);
      }

      if (!vellumDeliveryId) {
        const fallback = createCanonicalGuardianDelivery({
          requestId: canonicalRequest.id,
          destinationChannel: 'vellum',
        });
        updateCanonicalGuardianDelivery(fallback.id, { status: 'failed' });
        log.warn(
          { requestId: canonicalRequest.id, reason: signalResult.reason },
          'Notification pipeline did not produce a vellum delivery result for access request',
        );
      }
    })
    .catch((err) => {
      log.error(
        { err, requestId: canonicalRequest.id, sourceChannel, actorExternalId },
        'Failed to persist access request delivery rows from notification pipeline',
      );
    });

  log.info(
    { sourceChannel, actorExternalId, senderIdentifier, guardianBindingChannel },
    'Guardian notified of access request',
  );

  return { notified: true, created: true, requestId: canonicalRequest.id };
}
