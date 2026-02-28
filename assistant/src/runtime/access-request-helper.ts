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
  createCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
} from '../memory/canonical-guardian-store.js';
import { listActiveBindingsByAssistant } from '../memory/channel-guardian-store.js';
import { emitNotificationSignal } from '../notifications/emit-signal.js';
import { getLogger } from '../util/logger.js';
import { getGuardianBinding } from './channel-guardian-service.js';
import { GUARDIAN_APPROVAL_TTL_MS } from './routes/channel-route-shared.js';

const log = getLogger('access-request-helper');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AccessRequestParams {
  canonicalAssistantId: string;
  sourceChannel: ChannelId;
  externalChatId: string;
  senderExternalUserId?: string;
  senderName?: string;
  senderUsername?: string;
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
    externalChatId,
    senderExternalUserId,
    senderName,
    senderUsername,
  } = params;

  if (!senderExternalUserId) {
    return { notified: false, reason: 'no_sender_id' };
  }

  // Resolve guardian binding with fallback strategy:
  // 1. Source-channel active binding
  // 2. Any active binding for the assistant (deterministic order)
  // 3. null (no guardian identity — notification pipeline uses trusted channels)
  const sourceBinding = getGuardianBinding(canonicalAssistantId, sourceChannel);
  let guardianExternalUserId: string | null = null;
  let guardianBindingChannel: string | null = null;

  if (sourceBinding) {
    guardianExternalUserId = sourceBinding.guardianExternalUserId;
    guardianBindingChannel = sourceBinding.channel;
  } else {
    const allBindings = listActiveBindingsByAssistant(canonicalAssistantId);
    if (allBindings.length > 0) {
      guardianExternalUserId = allBindings[0].guardianExternalUserId;
      guardianBindingChannel = allBindings[0].channel;
      log.debug(
        { sourceChannel, fallbackChannel: guardianBindingChannel, canonicalAssistantId },
        'Using cross-channel guardian binding fallback for access request',
      );
    } else {
      log.debug(
        { sourceChannel, canonicalAssistantId },
        'No guardian binding for access request — proceeding without guardian identity',
      );
    }
  }

  // The conversationId is assistant-scoped so the dedupe query below only
  // matches requests for the same assistant. Without this, a pending request
  // from assistant A could be returned for assistant B, allowing the caller
  // to piggyback on A's guardian approval.
  const conversationId = `access-req-${canonicalAssistantId}-${sourceChannel}-${senderExternalUserId}`;

  // Deduplicate: skip creation if there is already a pending canonical request
  // for the same requester on this channel *and* assistant. Still return
  // notified: true with the existing request ID so callers know the guardian
  // was already notified.
  const existingCanonical = listCanonicalGuardianRequests({
    status: 'pending',
    requesterExternalUserId: senderExternalUserId,
    sourceChannel,
    kind: 'access_request',
    conversationId,
  });
  if (existingCanonical.length > 0) {
    log.debug(
      { sourceChannel, senderExternalUserId, existingId: existingCanonical[0].id },
      'Skipping duplicate access request notification',
    );
    return { notified: true, created: false, requestId: existingCanonical[0].id };
  }

  const senderIdentifier = senderName || senderUsername || senderExternalUserId;
  const requestId = `access-req-${canonicalAssistantId}-${sourceChannel}-${senderExternalUserId}-${Date.now()}`;

  const canonicalRequest = createCanonicalGuardianRequest({
    id: requestId,
    kind: 'access_request',
    sourceType: 'channel',
    sourceChannel,
    conversationId,
    requesterExternalUserId: senderExternalUserId,
    requesterChatId: externalChatId,
    guardianExternalUserId: guardianExternalUserId ?? undefined,
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
      requestCode: canonicalRequest.requestCode,
      sourceChannel,
      externalChatId,
      senderExternalUserId,
      senderName: senderName ?? null,
      senderUsername: senderUsername ?? null,
      senderIdentifier,
      guardianBindingChannel,
    },
    dedupeKey: `access-request:${canonicalRequest.id}`,
  });

  log.info(
    { sourceChannel, senderExternalUserId, senderIdentifier, guardianBindingChannel },
    'Guardian notified of access request',
  );

  return { notified: true, created: true, requestId: canonicalRequest.id };
}
