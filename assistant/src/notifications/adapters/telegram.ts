/**
 * Telegram channel adapter — delivers notifications to Telegram chats
 * via the gateway's channel-reply endpoint.
 *
 * Follows the same delivery pattern used by guardian-dispatch: POST to
 * the gateway's `/deliver/telegram` endpoint with a chat ID and text
 * payload. The gateway forwards the message to the Telegram Bot API.
 */

import { getGatewayInternalBaseUrl } from "../../config/env.js";
import { mintDaemonDeliveryToken } from "../../runtime/auth/token-service.js";
import { deliverChannelReply } from "../../runtime/gateway-client.js";
import { getLogger } from "../../util/logger.js";
import { isConversationSeedSane } from "../conversation-seed-composer.js";
import { nonEmpty } from "../copy-composer.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  DeliveryResult,
  NotificationChannel,
} from "../types.js";

const log = getLogger("notif-adapter-telegram");

function resolveTelegramMessageText(payload: ChannelDeliveryPayload): string {
  const deliveryText = nonEmpty(payload.copy.deliveryText);
  if (deliveryText) return deliveryText;

  if (isConversationSeedSane(payload.copy.conversationSeedMessage)) {
    return payload.copy.conversationSeedMessage.trim();
  }

  const body = nonEmpty(payload.copy.body);
  if (body) return body;

  const title = nonEmpty(payload.copy.title);
  if (title) return title;

  return payload.sourceEventName.replace(/[._]/g, " ");
}

export class TelegramAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel = "telegram";

  async send(
    payload: ChannelDeliveryPayload,
    destination: ChannelDestination,
  ): Promise<DeliveryResult> {
    const chatId = destination.endpoint;
    if (!chatId) {
      log.warn(
        { sourceEventName: payload.sourceEventName },
        "Telegram destination has no chat ID — skipping",
      );
      return {
        success: false,
        error: "No chat ID configured for Telegram destination",
      };
    }

    const gatewayBase = getGatewayInternalBaseUrl();
    const deliverUrl = `${gatewayBase}/deliver/telegram`;

    // Telegram is a chat surface, not a native popup. Use channel-native
    // delivery copy when available and avoid deterministic label prefixes.
    const messageText = resolveTelegramMessageText(payload);

    try {
      await deliverChannelReply(
        deliverUrl,
        { chatId, text: messageText },
        mintDaemonDeliveryToken(),
      );

      log.info(
        { sourceEventName: payload.sourceEventName, chatId },
        "Telegram notification delivered",
      );

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, sourceEventName: payload.sourceEventName, chatId },
        "Failed to deliver Telegram notification",
      );
      return { success: false, error: message };
    }
  }
}
