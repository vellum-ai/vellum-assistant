import { ChannelDeliveryError } from "@vellumai/gateway-client/http-delivery";

import { getLogger } from "../../../util/logger.js";
import type {
  CallbackContext,
  ChannelTransport,
} from "../channel-transport.js";
import { isBusyActivityPhase } from "../channel-transport.js";
import type { TelegramSendOptions } from "./send.js";
import {
  editTelegramMessage,
  sendTelegramAttachments,
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

  // Telegram clears a chat action after about five seconds.
  activityRefreshMs: 4_000,

  async deliver(ctx, payload) {
    const { chatId, text, attachments, approval } = payload;
    const opts = threadOptions(ctx);

    if (text) {
      // Telegram answers a rich render by forwarding markdown to
      // `sendRichMessage`, degrading to plain text otherwise and on any
      // rich-send rejection.
      if (payload.renderRichly) {
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

  async edit(_ctx, target) {
    await editTelegramMessage(target.chatId, target.messageId, target.text);
    return { ok: true };
  },

  async setActivity(ctx, target) {
    // Telegram's chat action expires by itself after a few seconds, so a phase
    // that is not running needs no clearing call.
    if (!isBusyActivityPhase(target.phase)) {
      return { ok: true };
    }
    await sendTelegramTypingIndicator(target.chatId, threadOptions(ctx));
    log.debug(
      { chatId: target.chatId, phase: target.phase },
      "Telegram typing indicator delivered (direct)",
    );
    return { ok: true };
  },
};
