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
  ChannelDeliveryPayload,
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

  async send(payload: ChannelDeliveryPayload, _destination: ChannelDestination): Promise<DeliveryResult> {
    try {
      this.broadcast({
        type: 'notification_intent',
        sourceEventName: payload.sourceEventName,
        title: payload.copy.title,
        body: payload.copy.body,
        deepLinkMetadata: payload.deepLinkTarget,
      } as ServerMessage);

      log.info(
        { sourceEventName: payload.sourceEventName, title: payload.copy.title },
        'macOS notification intent broadcast',
      );

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error({ err, sourceEventName: payload.sourceEventName }, 'Failed to broadcast macOS notification intent');
      return { success: false, error: message };
    }
  }
}
