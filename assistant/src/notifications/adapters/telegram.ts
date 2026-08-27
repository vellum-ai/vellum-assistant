/**
 * Telegram channel adapter — delivers notifications to Telegram chats
 * by calling the Telegram Bot API directly.
 *
 * When the delivery payload carries an `approvalContext` (built centrally
 * by the broadcaster), inline keyboard buttons ("Approve once", "Reject")
 * are attached. If the rich delivery fails, the adapter falls back to
 * plain text with typed-command instructions.
 */

import {
  editTelegramMessage,
  sendTelegramReply,
} from "../../messaging/providers/telegram-bot/send.js";
import { ConfigError } from "../../util/errors.js";
import { getLogger } from "../../util/logger.js";
import type {
  ChannelAdapter,
  ChannelDeliveryPayload,
  ChannelDestination,
  ChannelUpdateContext,
  ChannelUpdatePayload,
  DeliveryResult,
  NotificationChannel,
} from "../types.js";
import { appendPlainTextFallback, resolveMessageText } from "./shared.js";

const log = getLogger("notif-adapter-telegram");

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

    const messageText = resolveMessageText(payload);
    const approval = payload.approvalContext;

    try {
      if (approval) {
        // Attempt rich delivery with inline keyboard buttons.
        // On failure, fall back to plain text below.
        try {
          const sent = await sendTelegramReply(chatId, messageText, approval);

          log.info(
            { sourceEventName: payload.sourceEventName, chatId },
            "Telegram approval notification delivered with inline buttons",
          );

          // The message id lets the delivery row address the card later
          // (in-place withdrawal when the request resolves elsewhere).
          return { success: true, messageId: sent.lastMessageId };
        } catch (richErr) {
          log.warn(
            { err: richErr, sourceEventName: payload.sourceEventName, chatId },
            "Rich Telegram delivery failed — falling back to plain text",
          );
        }
      }

      // When falling back from rich delivery, append the plain-text
      // instructions so the guardian still knows how to approve/reject.
      const sent = await sendTelegramReply(
        chatId,
        appendPlainTextFallback(messageText, approval),
      );

      log.info(
        { sourceEventName: payload.sourceEventName, chatId },
        "Telegram notification delivered",
      );

      return { success: true, messageId: sent.lastMessageId };
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

  /**
   * Replace a delivered notification in place, so a card that has been
   * answered or withdrawn stops reading as still waiting.
   *
   * `editTelegramMessage` clears the card's inline keyboard as part of the
   * revision, so a card rewritten to read as settled cannot keep live Approve
   * and Reject buttons beside that text.
   */
  async update(
    delivery: ChannelUpdateContext,
    patch: ChannelUpdatePayload,
  ): Promise<DeliveryResult> {
    if (!delivery.messageId) {
      return {
        success: false,
        error:
          "missing_message_id: this delivery has no captured Telegram message id",
      };
    }
    const text = patch.body?.trim() || patch.title?.trim();
    if (!text) {
      return { success: false, error: "no body or title supplied for update" };
    }
    try {
      await editTelegramMessage(delivery.destination, delivery.messageId, text);
      log.info(
        { chatId: delivery.destination, messageId: delivery.messageId },
        "Telegram notification updated",
      );
      // An edit keeps the message it addressed, so the delivery row's id
      // still identifies the card.
      return { success: true, messageId: delivery.messageId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      log.error(
        { err, chatId: delivery.destination, messageId: delivery.messageId },
        "Failed to update Telegram notification",
      );
      return { success: false, error: message };
    }
  }
}
