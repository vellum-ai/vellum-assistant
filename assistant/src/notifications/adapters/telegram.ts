/**
 * Telegram channel adapter — delivers notifications to Telegram chats
 * via the gateway's channel-reply endpoint.
 *
 * Follows the same delivery pattern used by guardian-dispatch: POST to
 * the gateway's `/deliver/telegram` endpoint with a chat ID and text
 * payload. The gateway forwards the message to the Telegram Bot API.
 */

import { getGatewayInternalBaseUrl } from '../../config/env.js';
import { deliverChannelReply } from '../../runtime/gateway-client.js';
import { getLogger } from '../../util/logger.js';
import { readHttpToken } from '../../util/platform.js';
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  DeliveryResult,
  NotificationChannel,
} from '../types.js';

const log = getLogger('notif-adapter-telegram');

export class TelegramAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel = 'telegram';

  async send(payload: ChannelDeliveryPayload, destination: ChannelDestination): Promise<DeliveryResult> {
    const chatId = destination.endpoint;
    if (!chatId) {
      log.warn({ sourceEventName: payload.sourceEventName }, 'Telegram destination has no chat ID — skipping');
      return { success: false, error: 'No chat ID configured for Telegram destination' };
    }

    const gatewayBase = getGatewayInternalBaseUrl();
    const deliverUrl = `${gatewayBase}/deliver/telegram`;

    // Format copy for Telegram as plain text (no parse_mode set on gateway side)
    let messageText = payload.copy.title + '\n\n' + payload.copy.body;
    if (payload.copy.threadTitle) {
      messageText += '\n\nThread: ' + payload.copy.threadTitle;
    }

    try {
      await deliverChannelReply(
        deliverUrl,
        { chatId, text: messageText },
        readHttpToken() ?? undefined,
      );

      log.info(
        { sourceEventName: payload.sourceEventName, chatId },
        'Telegram notification delivered',
      );

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, sourceEventName: payload.sourceEventName, chatId },
        'Failed to deliver Telegram notification',
      );
      return { success: false, error: message };
    }
  }
}