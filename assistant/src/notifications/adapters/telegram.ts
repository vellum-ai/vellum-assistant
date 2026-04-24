/**
 * Telegram channel adapter — delivers notifications to Telegram chats
 * by calling the Telegram Bot API directly.
 *
 * For access request notifications, inline keyboard buttons ("Approve once",
 * "Reject") are attached so the guardian can act without typing a command.
 * If the rich delivery fails, the adapter falls back to plain text with
 * typed-command instructions.
 */

import { sendTelegramReply } from "../../messaging/providers/telegram-bot/send.js";
import type { ApprovalUIMetadata } from "../../runtime/channel-approval-types.js";
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
 * Build an {@link ApprovalUIMetadata} for an access request so the delivery
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

    const messageText = resolveTelegramMessageText(payload);

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
          await sendTelegramReply(chatId, messageText, approval);

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

      // When falling back from rich delivery, append the plain-text
      // instructions so the guardian still knows how to approve/reject.
      const fallbackText =
        approval?.plainTextFallback &&
        !messageText.includes(approval.plainTextFallback)
          ? `${messageText}\n\n${approval.plainTextFallback}`
          : messageText;

      await sendTelegramReply(chatId, fallbackText);

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
