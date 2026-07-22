import { ChannelDeliveryError } from "@vellumai/gateway-client/http-delivery";

import { getLogger } from "../../../util/logger.js";
import type { ChannelTransport } from "../channel-transport.js";
import {
  sendTelegramAttachments,
  sendTelegramReply,
  sendTelegramRichReply,
  sendTelegramTypingIndicator,
} from "./send.js";

const log = getLogger("telegram-transport");

function messageThreadOpts(ctx: {
  params: Readonly<Record<string, string>>;
}): { messageThreadId?: string } | undefined {
  const threadId = ctx.params.threadId?.trim();
  return threadId ? { messageThreadId: threadId } : undefined;
}

export const telegramTransport: ChannelTransport = {
  channel: "telegram",

  async deliver(ctx, payload) {
    const { chatId, text, attachments, approval } = payload;
    const threadOpts = messageThreadOpts(ctx);

    if (text) {
      // `useBlocks` is the channel-neutral "render richly" intent set by the
      // delivery layer; the Telegram adapter honors it by forwarding markdown
      // to `sendRichMessage`, degrading to plain text otherwise (and on any
      // rich-send rejection).
      if (payload.useBlocks) {
        await sendTelegramRichReply(chatId, text, approval, threadOpts);
      } else {
        await sendTelegramReply(chatId, text, approval, threadOpts);
      }
    } else if (approval) {
      await sendTelegramReply(
        chatId,
        approval.plainTextFallback || "Approval required",
        approval,
        threadOpts,
      );
    }

    if (attachments && attachments.length > 0) {
      const result = await sendTelegramAttachments(
        chatId,
        attachments,
        threadOpts,
      );
      if (result.allFailed && !text) {
        throw new ChannelDeliveryError(
          502,
          `All ${result.failureCount} attachments failed to deliver`,
        );
      }
    }

    log.info(
      { chatId, hasText: !!text, messageThreadId: threadOpts?.messageThreadId },
      "Telegram reply delivered (direct)",
    );
    return { ok: true };
  },

  async sendTyping(ctx, payload) {
    await sendTelegramTypingIndicator(payload.chatId, messageThreadOpts(ctx));
    log.debug(
      { chatId: payload.chatId },
      "Telegram typing indicator delivered (direct)",
    );
    return { ok: true };
  },
};
