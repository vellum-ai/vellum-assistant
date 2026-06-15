/**
 * Telegram channel adapter — delivers notifications to Telegram chats
 * by calling the Telegram Bot API directly.
 *
 * When the delivery payload carries an `approvalContext` (built centrally
 * by the broadcaster), inline keyboard buttons ("Approve once", "Reject")
 * are attached. If the rich delivery fails, the adapter falls back to
 * plain text with typed-command instructions.
 */

import { sendTelegramReply } from "../../messaging/providers/telegram-bot/send.js";
import { ConfigError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import { isConversationSeedSane } from "../conversation-seed-composer.js";
import { nonEmpty } from "../notification-utils.js";
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

    const messageText = resolveTelegramMessageText(payload);
    const approval = payload.approvalContext;

    try {
      if (approval) {
        // Attempt rich delivery with inline keyboard buttons.
        // On failure, fall back to plain text below.
        try {
          await sendTelegramReply(chatId, messageText, approval);

          log.info(
            { sourceEventName: payload.sourceEventName, chatId },
            "Telegram approval notification delivered with inline buttons",
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
      // A missing bot token means the operator simply hasn't configured
      // Telegram; it is not a code fault, so log it at warn to keep it out
      // of Sentry. Genuine and transient failures (e.g. an unreachable
      // credential store) stay at error so they remain visible.
      const logFn = err instanceof ConfigError ? log.warn : log.error;
      logFn(
        { err, sourceEventName: payload.sourceEventName, chatId },
        "Failed to deliver Telegram notification",
      );
      return { success: false, error: message };
    }
  }
}
