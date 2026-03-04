/**
 * Slack channel adapter -- delivers notifications to Slack channels/DMs
 * via the gateway's `/deliver/slack` endpoint.
 *
 * Follows the same delivery pattern as the Telegram and SMS adapters:
 * POST to the gateway delivery endpoint with a chat ID and text payload.
 *
 * Supports scheduled delivery: when the notification signal has a
 * `deadlineAt` attention hint, the message is scheduled for that time
 * using Slack's `chat.scheduleMessage` API (via the gateway's `schedule_at`
 * parameter).
 */

import { getGatewayInternalBaseUrl } from "../../config/env.js";
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

const log = getLogger("notif-adapter-slack");

function resolveSlackMessageText(payload: ChannelDeliveryPayload): string {
  const deliveryText = nonEmpty(payload.copy.deliveryText);
  if (deliveryText) return deliveryText;

  const body = nonEmpty(payload.copy.body);
  if (body) return body;

  const title = nonEmpty(payload.copy.title);
  if (title) return title;

  return payload.sourceEventName.replace(/[._]/g, " ");
}

export class SlackAdapter implements ChannelAdapter {
  readonly channel: NotificationChannel = "slack" as NotificationChannel;

  async send(
    payload: ChannelDeliveryPayload,
    destination: ChannelDestination,
  ): Promise<DeliveryResult> {
    const chatId = destination.endpoint;
    if (!chatId) {
      log.warn(
        { sourceEventName: payload.sourceEventName },
        "Slack destination has no chat ID -- skipping",
      );
      return {
        success: false,
        error: "No chat ID configured for Slack destination",
      };
    }

    const gatewayBase = getGatewayInternalBaseUrl();
    const deliverUrl = `${gatewayBase}/deliver/slack`;

    const messageText = resolveSlackMessageText(payload);

    try {
      await deliverChannelReply(
        deliverUrl,
        { chatId, text: messageText },
        mintDaemonDeliveryToken(),
      );

      log.info(
        { sourceEventName: payload.sourceEventName, chatId },
        "Slack notification delivered",
      );

      return { success: true };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, sourceEventName: payload.sourceEventName, chatId },
        "Failed to deliver Slack notification",
      );
      return { success: false, error: message };
    }
  }
}
