/**
 * Vellum channel adapter — delivers notifications to connected desktop
 * and mobile clients via the daemon's IPC broadcast mechanism.
 *
 * The adapter broadcasts a `notification_intent` message that the Vellum
 * client can use to display a native notification (e.g. NSUserNotification
 * or UNUserNotificationCenter).
 */

import type { ServerMessage } from '../../daemon/ipc-contract.js';
import { getLogger } from '../../util/logger.js';
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  DeliveryResult,
  NotificationChannel,
} from '../types.js';

const log = getLogger('notif-adapter-vellum');

export type BroadcastFn = (msg: ServerMessage) => void;

export class VellumAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel = 'vellum';

  private broadcast: BroadcastFn;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  async send(payload: ChannelDeliveryPayload, _destination: ChannelDestination): Promise<DeliveryResult> {
    try {
      this.broadcast({
        type: 'notification_intent',
        deliveryId: payload.deliveryId,
        sourceEventName: payload.sourceEventName,
        title: payload.copy.title,
        body: payload.copy.body,
        deepLinkMetadata: payload.deepLinkTarget,
      } as ServerMessage);

      log.info(
        { sourceEventName: payload.sourceEventName, title: payload.copy.title },
        'Vellum notification intent broadcast',
      );

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, sourceEventName: payload.sourceEventName }, 'Failed to broadcast Vellum notification intent');
      return { success: false, error: message };
    }
  }
}
