import type { NotificationIntentResult } from '../daemon/ipc-contract/notifications.js';
import { addMessage } from '../memory/conversation-store.js';
import { getLogger } from '../util/logger.js';
import { getDeliveryById, updateDeliveryClientOutcome } from './deliveries-store.js';

const log = getLogger('notification-intent-result-handler');

const AUTHORIZATION_DENIED_THREAD_NOTE = [
  "I could not show a macOS banner for this notification because notifications are disabled for Vellum.",
  'You can still read the update here in this thread.',
  'To enable banners: System Settings -> Notifications -> Vellum -> Allow Notifications.',
].join('\n\n');

/**
 * Persist the client-side notification outcome and optionally add a
 * conversation-visible fallback note when the OS blocks banner delivery.
 */
export function handleNotificationIntentResult(msg: NotificationIntentResult): void {
  const delivery = getDeliveryById(msg.deliveryId);
  const alreadyAcknowledged = delivery?.clientDeliveryStatus != null;

  const updated = updateDeliveryClientOutcome(
    msg.deliveryId,
    msg.success,
    msg.errorMessage || msg.errorCode
      ? { code: msg.errorCode, message: msg.errorMessage }
      : undefined,
  );
  if (!updated) {
    log.warn({ deliveryId: msg.deliveryId }, 'notification_intent_result: no delivery row found for deliveryId');
    return;
  }

  // Duplicate acks should not append duplicate conversation notes.
  if (alreadyAcknowledged || msg.success) {
    return;
  }
  if (msg.errorCode !== 'authorization_denied') {
    return;
  }
  if (!delivery || delivery.channel !== 'vellum' || !delivery.conversationId) {
    return;
  }

  try {
    addMessage(
      delivery.conversationId,
      'assistant',
      AUTHORIZATION_DENIED_THREAD_NOTE,
      {
        assistantMessageChannel: 'vellum',
        notificationDeliveryFeedback: {
          deliveryId: msg.deliveryId,
          errorCode: msg.errorCode,
        },
      },
      { skipIndexing: true },
    );
  } catch (err) {
    log.error(
      { err, deliveryId: msg.deliveryId, conversationId: delivery.conversationId },
      'notification_intent_result: failed to append authorization-denied thread note',
    );
  }
}
