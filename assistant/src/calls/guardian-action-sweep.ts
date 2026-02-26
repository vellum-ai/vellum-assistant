/**
 * Periodic sweep for expired guardian action requests.
 *
 * Runs on a 60-second interval. When a request has passed its expiresAt
 * timestamp:
 * 1. Expires the request and all its deliveries in the store
 * 2. Expires the associated pending question so the call-side timeout fires
 * 3. Sends expiry notices to external delivery destinations (telegram, sms)
 * 4. Adds an expiry message to mac guardian thread conversations
 */

import { addMessage } from '../memory/conversation-store.js';
import type { GuardianActionDelivery } from '../memory/guardian-action-store.js';
import {
  expireGuardianActionRequest,
  getDeliveriesByRequestId,
  getExpiredGuardianActionRequests,
} from '../memory/guardian-action-store.js';
import { deliverChannelReply } from '../runtime/gateway-client.js';
import { getLogger } from '../util/logger.js';
import { expirePendingQuestions } from './call-store.js';

const log = getLogger('guardian-action-sweep');

const SWEEP_INTERVAL_MS = 60_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

/**
 * Send expiry notices to all delivery destinations for a guardian action
 * request. Handles both vellum/mac thread messages and external channel
 * replies (telegram, sms).
 *
 * Deliveries must be captured *before* their status is changed to 'expired'
 * so the sent/pending filter still matches.
 */
export function sendGuardianExpiryNotices(
  deliveries: GuardianActionDelivery[],
  assistantId: string,
  gatewayBaseUrl: string,
  bearerToken?: string,
): void {
  for (const delivery of deliveries) {
    if (delivery.status !== 'sent' && delivery.status !== 'pending') continue;

    if ((delivery.destinationChannel === 'vellum' || delivery.destinationChannel === 'macos' || delivery.destinationChannel === 'mac') && delivery.destinationConversationId) {
      // Add expiry message to vellum guardian thread
      addMessage(
        delivery.destinationConversationId,
        'assistant',
        JSON.stringify([{ type: 'text', text: 'This guardian question has expired without a response.' }]),
        { userMessageChannel: 'voice', assistantMessageChannel: 'vellum', userMessageInterface: 'voice', assistantMessageInterface: 'vellum' },
      );
    } else if (delivery.destinationChatId) {
      // External channel — send expiry notice
      const deliverUrl = `${gatewayBaseUrl}/deliver/${delivery.destinationChannel}`;
      void (async () => {
        try {
          await deliverChannelReply(deliverUrl, {
            chatId: delivery.destinationChatId!,
            text: 'The guardian question has expired without a response. The call has moved on.',
            assistantId,
          }, bearerToken);
        } catch (err) {
          log.error(
            { err, deliveryId: delivery.id, channel: delivery.destinationChannel },
            'Failed to deliver guardian action expiry notice',
          );
        }
      })();
    }
  }
}

/**
 * Sweep expired guardian action requests and clean up.
 */
export function sweepExpiredGuardianActions(
  gatewayBaseUrl: string,
  bearerToken?: string,
): void {
  const expired = getExpiredGuardianActionRequests();

  for (const request of expired) {
    // Capture deliveries before expiring (since expiry changes their status)
    const deliveries = getDeliveriesByRequestId(request.id);

    // Expire the request and all deliveries
    expireGuardianActionRequest(request.id, 'sweep_timeout');

    // Expire associated pending questions
    expirePendingQuestions(request.callSessionId);

    log.info(
      { requestId: request.id, callSessionId: request.callSessionId },
      'Expired guardian action request',
    );

    sendGuardianExpiryNotices(deliveries, request.assistantId, gatewayBaseUrl, bearerToken);
  }
}

export function startGuardianActionSweep(
  gatewayBaseUrl: string,
  bearerToken?: string,
): void {
  if (sweepTimer) return;
  sweepTimer = setInterval(() => {
    try {
      sweepExpiredGuardianActions(gatewayBaseUrl, bearerToken);
    } catch (err) {
      log.error({ err }, 'Guardian action sweep failed');
    }
  }, SWEEP_INTERVAL_MS);
}

export function stopGuardianActionSweep(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer);
    sweepTimer = null;
  }
}
