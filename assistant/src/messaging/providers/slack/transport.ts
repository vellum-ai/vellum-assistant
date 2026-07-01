import { ChannelDeliveryError } from "@vellumai/gateway-client/http-delivery";

import { getLogger } from "../../../util/logger.js";
import type { ChannelTransport } from "../channel-transport.js";
import {
  sendSlackAssistantThreadStatus,
  sendSlackAttachments,
  sendSlackReaction,
  sendSlackReply,
  sendSlackStreamOp,
  sendSlackTypingIndicator,
} from "./send.js";

const log = getLogger("slack-transport");

export const slackTransport: ChannelTransport = {
  channel: "slack",

  async deliver(ctx, payload) {
    const { chatId, text, attachments, blocks } = payload;
    const threadTs = ctx.params.threadTs;

    let sentTs: string | undefined;
    if (text) {
      const result = await sendSlackReply(chatId, text, {
        threadTs,
        blocks,
        approval: payload.approval,
        useBlocks: payload.useBlocks,
        ephemeral: payload.ephemeral,
        user: payload.user,
        messageTs: payload.messageTs,
      });
      sentTs = result.ts;
    } else if (payload.approval) {
      const result = await sendSlackReply(
        chatId,
        payload.approval.plainTextFallback || "Approval required",
        { threadTs, approval: payload.approval },
      );
      sentTs = result.ts;
    }

    if (attachments && attachments.length > 0) {
      const result = await sendSlackAttachments(chatId, attachments, threadTs);
      if (result.allFailed && !text) {
        throw new ChannelDeliveryError(
          502,
          `All ${result.failureCount} attachments failed to deliver`,
        );
      }
    }

    log.info({ chatId, hasText: !!text }, "Slack reply delivered (direct)");
    return { ok: true, ts: sentTs };
  },

  async sendTyping(ctx, payload) {
    const placeholderTs = await sendSlackTypingIndicator(
      payload.chatId,
      ctx.params.threadTs,
    );
    log.debug(
      { chatId: payload.chatId },
      "Slack typing indicator delivered (direct)",
    );
    return { ok: true, ts: placeholderTs };
  },

  async sendReaction(_ctx, payload) {
    const reaction = payload.reaction;
    if (!reaction) return { ok: true };
    await sendSlackReaction(
      payload.chatId,
      reaction.name,
      reaction.messageTs,
      reaction.action,
    );
    return { ok: true };
  },

  async setThreadStatus(_ctx, payload) {
    const status = payload.assistantThreadStatus;
    if (!status) return { ok: true };
    await sendSlackAssistantThreadStatus(
      status.channel,
      status.threadTs,
      status.status,
      status.loadingMessages,
    );
    return { ok: true };
  },

  async streamReply(_ctx, payload) {
    const op = payload.slackStream;
    if (!op) return { ok: true };
    return sendSlackStreamOp(payload.chatId, op);
  },
};
