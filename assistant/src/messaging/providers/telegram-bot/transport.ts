import { ChannelDeliveryError } from "@vellumai/gateway-client/http-delivery";

import { getLogger } from "../../../util/logger.js";
import type {
  CallbackContext,
  ChannelTransport,
} from "../channel-transport.js";
import type { TelegramSendOptions } from "./send.js";
import {
  editTelegramMessageText,
  sendTelegramAttachments,
  sendTelegramQuestion,
  sendTelegramReply,
  sendTelegramRichReply,
  sendTelegramTypingIndicator,
} from "./send.js";

const log = getLogger("telegram-transport");

/**
 * Topic targeting from the deliver callback URL's `threadId` param.
 * Absent → main chat.
 */
function threadOptions(ctx: CallbackContext): TelegramSendOptions | undefined {
  const threadId = ctx.params.threadId?.trim();
  return threadId ? { messageThreadId: threadId } : undefined;
}

export const telegramTransport: ChannelTransport = {
  channel: "telegram",

  async deliver(ctx, payload) {
    const { chatId, text, attachments, approval, question } = payload;
    const opts = threadOptions(ctx);

    // Channel-native question wizard step: send the first message (returning its
    // id so the wizard can edit it later) or, with `messageTs`, edit in place to
    // advance. Handled before the generic text path — a question payload also
    // carries the step's display text.
    if (question) {
      const ts = await sendTelegramQuestion(
        chatId,
        text ?? question.plainTextFallback,
        question,
        payload.messageTs,
        opts,
      );
      log.info(
        { chatId, edit: !!payload.messageTs },
        "Telegram question step delivered (direct)",
      );
      return { ok: true, ts };
    }

    // Wizard finalize: rewrite the message text and drop the inline keyboard in
    // one edit. Telegram payloads only set `messageTs` for this today; honoring
    // it matches the field's "update existing message" semantics.
    if (payload.messageTs && text) {
      await editTelegramMessageText(chatId, payload.messageTs, text);
      log.info({ chatId }, "Telegram message edited in place (direct)");
      return { ok: true, ts: payload.messageTs };
    }

    if (text) {
      // `useBlocks` is the channel-neutral "render richly" intent set by the
      // delivery layer; the Telegram adapter honors it by forwarding markdown
      // to `sendRichMessage`, degrading to plain text otherwise (and on any
      // rich-send rejection).
      if (payload.useBlocks) {
        await sendTelegramRichReply(chatId, text, approval, opts);
      } else {
        await sendTelegramReply(chatId, text, approval, opts);
      }
    } else if (approval) {
      await sendTelegramReply(
        chatId,
        approval.plainTextFallback || "Approval required",
        approval,
        opts,
      );
    }

    if (attachments && attachments.length > 0) {
      const result = await sendTelegramAttachments(chatId, attachments, opts);
      if (result.allFailed && !text) {
        throw new ChannelDeliveryError(
          502,
          `All ${result.failureCount} attachments failed to deliver`,
        );
      }
    }

    log.info(
      { chatId, hasText: !!text, messageThreadId: opts?.messageThreadId },
      "Telegram reply delivered (direct)",
    );
    return { ok: true };
  },

  async sendTyping(ctx, payload) {
    await sendTelegramTypingIndicator(payload.chatId, threadOptions(ctx));
    log.debug(
      { chatId: payload.chatId },
      "Telegram typing indicator delivered (direct)",
    );
    return { ok: true };
  },
};
