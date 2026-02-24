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

import { getLogger } from '../util/logger.js';
import {
  getExpiredGuardianActionRequests,
  expireGuardianActionRequest,
  getDeliveriesByRequestId,
} from '../memory/guardian-action-store.js';
import { expirePendingQuestions } from './call-store.js';
import { deliverChannelReply } from '../runtime/gateway-client.js';
import { addMessage } from '../memory/conversation-store.js';

const log = getLogger('guardian-action-sweep');

const SWEEP_INTERVAL_MS = 60_000;

let sweepTimer: ReturnType<typeof setInterval> | null = null;

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
    expireGuardianActionRequest(request.id);

    // Expire associated pending questions
    expirePendingQuestions(request.callSessionId);

    log.info(
      { requestId: request.id, callSessionId: request.callSessionId },
      'Expired guardian action request',
    );

    // Send expiry notices to each delivery destination
    for (const delivery of deliveries) {
      if (delivery.status !== 'sent' && delivery.status !== 'pending') continue;

      if (delivery.destinationChannel === 'mac' && delivery.destinationConversationId) {
        // Add expiry message to mac guardian thread
        addMessage(
          delivery.destinationConversationId,
          'assistant',
          JSON.stringify('This guardian question has expired without a response.'),
        );
      } else if (delivery.destinationChatId) {
        // External channel — send expiry notice
        const deliverUrl = `${gatewayBaseUrl}/deliver/${delivery.destinationChannel}`;
        void (async () => {
          try {
            await deliverChannelReply(deliverUrl, {
              chatId: delivery.destinationChatId!,
              text: 'The guardian question has expired without a response. The call has moved on.',
              assistantId: request.assistantId,
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
