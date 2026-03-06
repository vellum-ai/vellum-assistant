/**
 * SMS channel adapter — delivers notifications to phone numbers
 * via the gateway's SMS delivery endpoint (`/deliver/sms`).
 *
 * Follows the same delivery pattern as the Telegram adapter: POST to
 * the gateway's `/deliver/sms` endpoint with a phone number (as chatId)
 * and text payload. The gateway forwards the message to the Twilio
 * Messages API.
 *
 * Graceful degradation: when the gateway is unreachable or SMS is not
 * configured, the adapter returns a failed DeliveryResult without throwing,
 * so the broadcaster continues delivering to other channels.
 */

import { getGatewayInternalBaseUrl } from "../../config/env.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../../runtime/assistant-scope.js";
import { mintDaemonDeliveryToken } from "../../runtime/auth/token-service.js";
import { deliverChannelReply } from "../../runtime/gateway-client.js";
import { getLogger } from "../../util/logger.js";
import { nonEmpty } from "../copy-composer.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  DeliveryResult,
  NotificationChannel,
} from "../types.js";

const log = getLogger("notif-adapter-sms");

function resolveSmsMessageText(payload: ChannelDeliveryPayload): string {
  const deliveryText = nonEmpty(payload.copy.deliveryText);
  if (deliveryText) return deliveryText;

  const body = nonEmpty(payload.copy.body);
  if (body) return body;

  const title = nonEmpty(payload.copy.title);
  if (title) return title;

  return payload.sourceEventName.replace(/[._]/g, " ");
}

export class SmsAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel = "sms";

  async send(
    payload: ChannelDeliveryPayload,
    destination: ChannelDestination,
  ): Promise<DeliveryResult> {
    const phoneNumber = destination.endpoint;
    if (!phoneNumber) {
      log.warn(
        { sourceEventName: payload.sourceEventName },
        "SMS destination has no phone number — skipping",
      );
      return {
        success: false,
        error: "No phone number configured for SMS destination",
      };
    }

    const gatewayBase = getGatewayInternalBaseUrl();
    const deliverUrl = `${gatewayBase}/deliver/sms`;

    const messageText = resolveSmsMessageText(payload);

    try {
      await deliverChannelReply(
        deliverUrl,
        {
          chatId: phoneNumber,
          text: messageText,
          assistantId: DAEMON_INTERNAL_ASSISTANT_ID,
        },
        mintDaemonDeliveryToken(),
      );

      log.info(
        { sourceEventName: payload.sourceEventName, phoneNumber },
        "SMS notification delivered",
      );

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, sourceEventName: payload.sourceEventName, phoneNumber },
        "Failed to deliver SMS notification",
      );
      return { success: false, error: message };
    }
  }
}
