/**
 * Shared access-request creation and notification helper.
 *
 * Encapsulates the "create/dedupe canonical access request + emit notification"
 * logic so both text-channel and voice-channel ingress paths use identical
 * guardian notification flows.
 */

import type { ChannelId } from '../channels/types.js';
import {
  createCanonicalGuardianRequest,
  listCanonicalGuardianRequests,
} from '../memory/canonical-guardian-store.js';
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
  | { notified: false; reason: 'no_sender_id' | 'no_guardian_binding' };

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

  const binding = getGuardianBinding(canonicalAssistantId, sourceChannel);
  if (!binding) {
    log.debug({ sourceChannel, canonicalAssistantId }, 'No guardian binding for access request notification');
    return { notified: false, reason: 'no_guardian_binding' };
  }

  // Deduplicate: skip creation if there is already a pending canonical request
  // for the same requester on this channel. Still return notified: true with
  // the existing request ID so callers know the guardian was already notified.
  const existingCanonical = listCanonicalGuardianRequests({
    status: 'pending',
    requesterExternalUserId: senderExternalUserId,
    sourceChannel,
    kind: 'access_request',
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
    conversationId: `access-req-${sourceChannel}-${senderExternalUserId}`,
    requesterExternalUserId: senderExternalUserId,
    requesterChatId: externalChatId,
    guardianExternalUserId: binding.guardianExternalUserId,
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
      sourceChannel,
      externalChatId,
      senderExternalUserId,
      senderName: senderName ?? null,
      senderUsername: senderUsername ?? null,
      senderIdentifier,
    },
    dedupeKey: `access-request:${canonicalRequest.id}`,
  });

  log.info(
    { sourceChannel, senderExternalUserId, senderIdentifier },
    'Guardian notified of access request',
  );

  return { notified: true, created: true, requestId: canonicalRequest.id };
}
