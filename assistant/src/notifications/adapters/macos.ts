/**
 * macOS channel adapter — delivers notifications to connected desktop
 * clients via the daemon's IPC broadcast mechanism.
 *
 * The adapter broadcasts a `notification_intent` message that the macOS
 * client can use to display a native notification (e.g. NSUserNotification
 * or UNUserNotificationCenter).
 */

import { getLogger } from '../../util/logger.js';
import type { ServerMessage } from '../../daemon/ipc-contract.js';
import type {
  NotificationChannel,
  ChannelAdapter,
  PreparedDelivery,
  ChannelDestination,
  DeliveryResult,
} from '../types.js';

const log = getLogger('notif-adapter-macos');

export type BroadcastFn = (msg: ServerMessage) => void;

export class MacOSAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel = 'macos';

  private broadcast: BroadcastFn;

  constructor(broadcast: BroadcastFn) {
    this.broadcast = broadcast;
  }

  async send(delivery: PreparedDelivery, _destination: ChannelDestination): Promise<DeliveryResult> {
    try {
      this.broadcast({
        type: 'notification_intent',
        sourceEventName: delivery.sourceEventName,
        title: delivery.title,
        body: delivery.body,
        deepLinkMetadata: delivery.deepLinkMetadata,
      } as ServerMessage);

      log.info(
        { sourceEventName: delivery.sourceEventName, title: delivery.title },
        'macOS notification intent broadcast',
      );

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, sourceEventName: delivery.sourceEventName }, 'Failed to broadcast macOS notification intent');
      return { success: false, error: message };
    }
  }
}
