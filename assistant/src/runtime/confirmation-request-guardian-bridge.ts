/**
 * Bridge trusted-contact confirmation_request events to guardian.question notifications.
 *
 * When a trusted-contact channel session creates a confirmation_request (tool approval),
 * this helper emits a guardian.question notification signal and persists canonical
 * delivery rows to guardian destinations (Telegram/SMS/Vellum), enabling the guardian
 * to approve via callback/request-code path.
 *
 * Modeled after the tool-grant-request-helper pattern. Designed to be called from
 * both the daemon event registrar (server.ts) and the HTTP hub publisher
 * (conversation-routes.ts) — the two paths that create confirmation_request
 * canonical records.
 */

import type { GuardianRuntimeContext } from '../daemon/session-runtime-assembly.js';
import {
  createCanonicalGuardianDelivery,
  type CanonicalGuardianRequest,
} from '../memory/canonical-guardian-store.js';
import { emitNotificationSignal } from '../notifications/emit-signal.js';
import { getLogger } from '../util/logger.js';
import { getGuardianBinding } from './channel-guardian-service.js';

const log = getLogger('confirmation-request-guardian-bridge');

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface BridgeConfirmationRequestParams {
  /** The canonical guardian request already persisted for this confirmation_request. */
  canonicalRequest: CanonicalGuardianRequest;
  /** Guardian runtime context from the session. */
  guardianContext: GuardianRuntimeContext;
  /** Conversation ID where the confirmation_request was emitted. */
  conversationId: string;
  /** Tool name from the confirmation_request. */
  toolName: string;
  /** Logical assistant ID (defaults to 'self'). */
  assistantId?: string;
}

export type BridgeConfirmationRequestResult =
  | { bridged: true; signalId: string }
  | { skipped: true; reason: 'not_trusted_contact' | 'no_guardian_binding' | 'missing_guardian_identity' };

// ---------------------------------------------------------------------------
// Helper
// ---------------------------------------------------------------------------

/**
 * Bridge a trusted-contact confirmation_request to a guardian.question notification.
 *
 * Only emits when the session belongs to a trusted-contact actor with a
 * resolvable guardian binding. Guardian and unknown actors are skipped — guardians
 * self-approve, and unknown actors are already fail-closed by the routing layer.
 *
 * Fire-and-forget safe: notification emission errors are logged but not propagated.
 */
export function bridgeConfirmationRequestToGuardian(
  params: BridgeConfirmationRequestParams,
): BridgeConfirmationRequestResult {
  const {
    canonicalRequest,
    guardianContext,
    conversationId,
    toolName,
    assistantId = 'self',
  } = params;

  // Only bridge for trusted-contact sessions. Guardians self-approve and
  // unknown actors are fail-closed by the routing layer.
  if (guardianContext.trustClass !== 'trusted_contact') {
    return { skipped: true, reason: 'not_trusted_contact' };
  }

  if (!guardianContext.guardianExternalUserId) {
    log.debug(
      { conversationId, sourceChannel: guardianContext.sourceChannel },
      'Skipping guardian bridge: no guardian identity on trusted-contact context',
    );
    return { skipped: true, reason: 'missing_guardian_identity' };
  }

  const sourceChannel = guardianContext.sourceChannel;
  const binding = getGuardianBinding(assistantId, sourceChannel);
  if (!binding) {
    log.debug(
      { sourceChannel, assistantId },
      'No guardian binding for confirmation request bridge',
    );
    return { skipped: true, reason: 'no_guardian_binding' };
  }

  const senderLabel = guardianContext.requesterIdentifier
    || guardianContext.requesterExternalUserId
    || 'unknown';

  const questionText = `Tool approval request: ${toolName}`;

  // Emit guardian.question notification so the guardian is alerted.
  const signalPromise = emitNotificationSignal({
    sourceEventName: 'guardian.question',
    sourceChannel,
    sourceSessionId: conversationId,
    assistantId,
    attentionHints: {
      requiresAction: true,
      urgency: 'high',
      isAsyncBackground: false,
      visibleInSourceNow: false,
    },
    contextPayload: {
      requestId: canonicalRequest.id,
      requestCode: canonicalRequest.requestCode,
      sourceChannel,
      requesterExternalUserId: guardianContext.requesterExternalUserId,
      requesterChatId: guardianContext.requesterChatId ?? null,
      requesterIdentifier: senderLabel,
      toolName,
      questionText,
    },
    dedupeKey: `tc-confirmation-request:${canonicalRequest.id}`,
    onThreadCreated: (info) => {
      createCanonicalGuardianDelivery({
        requestId: canonicalRequest.id,
        destinationChannel: 'vellum',
        destinationConversationId: info.conversationId,
      });
    },
  });

  // Record channel deliveries from the notification pipeline (fire-and-forget).
  void signalPromise.then((signalResult) => {
    for (const result of signalResult.deliveryResults) {
      if (result.channel === 'vellum') continue; // handled in onThreadCreated
      if (result.channel !== 'telegram' && result.channel !== 'sms') continue;
      createCanonicalGuardianDelivery({
        requestId: canonicalRequest.id,
        destinationChannel: result.channel,
        destinationChatId: result.destination.length > 0 ? result.destination : undefined,
      });
    }
  });

  log.info(
    {
      sourceChannel,
      requesterExternalUserId: guardianContext.requesterExternalUserId,
      toolName,
      requestId: canonicalRequest.id,
      requestCode: canonicalRequest.requestCode,
    },
    'Guardian notified of trusted-contact confirmation request',
  );

  // Return the signal ID synchronously from the promise-producing call.
  // The actual signal ID is not available until the promise resolves, but
  // callers only need to know it was bridged — the ID is for diagnostics.
  // We use the canonical request ID as a stable correlation key.
  return { bridged: true, signalId: canonicalRequest.id };
}
