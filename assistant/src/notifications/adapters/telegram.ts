/**
 * Telegram channel adapter — delivers notifications to Telegram chats
 * via the gateway's channel-reply endpoint.
 *
 * Follows the same delivery pattern used by guardian-dispatch: POST to
 * the gateway's `/deliver/telegram` endpoint with a chat ID and text
 * payload. The gateway forwards the message to the Telegram Bot API.
 *
 * For access request notifications, inline keyboard buttons ("Approve once",
 * "Reject") are attached via the approval payload so the guardian can act
 * without typing a command. If the rich delivery fails, the adapter falls
 * back to plain text with typed-command instructions.
 */

import { getGatewayInternalBaseUrl } from "../../config/env.js";
import { mintDaemonDeliveryToken } from "../../runtime/auth/token-service.js";
import type { ApprovalUIMetadata } from "../../runtime/channel-approval-types.js";
import { deliverChannelReply } from "../../runtime/gateway-client.js";
import { getLogger } from "../../util/logger.js";
import { isConversationSeedSane } from "../conversation-seed-composer.js";
import { buildAccessRequestContractText, nonEmpty } from "../copy-composer.js";
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

/**
 * Build an {@link ApprovalUIMetadata} for an access request so the gateway
 * renders inline keyboard buttons in the Telegram message.
 *
 * Returns `undefined` when the context payload is missing the required
 * `requestId`, in which case the caller should fall back to plain text.
 */
function buildAccessRequestApproval(
  contextPayload: Record<string, unknown>,
): ApprovalUIMetadata | undefined {
  const requestId =
    typeof contextPayload.requestId === "string"
      ? contextPayload.requestId
      : undefined;
  if (!requestId) return undefined;

  const plainTextFallback = buildAccessRequestContractText(contextPayload);

  return {
    requestId,
    actions: [
      { id: "approve_once", label: "Approve once" },
      { id: "reject", label: "Reject" },
    ],
    plainTextFallback,
  };
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

    // For access requests, attach inline keyboard buttons so the guardian
    // can approve/reject with a single tap.
    const isAccessRequest =
      payload.sourceEventName === "ingress.access_request" &&
      payload.contextPayload != null;

    const approval = isAccessRequest
      ? buildAccessRequestApproval(payload.contextPayload!)
      : undefined;

    try {
      if (approval) {
        // Attempt rich delivery with inline keyboard buttons.
        // On failure, fall back to plain text below.
        try {
          await deliverChannelReply(
            deliverUrl,
            { chatId, text: messageText, approval },
            mintDaemonDeliveryToken(),
          );

          log.info(
            { sourceEventName: payload.sourceEventName, chatId },
            "Telegram access request notification delivered with inline buttons",
          );

          return { success: true };
        } catch (richErr) {
          log.warn(
            { err: richErr, sourceEventName: payload.sourceEventName, chatId },
            "Rich Telegram delivery failed — falling back to plain text",
          );
        }
      }

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
