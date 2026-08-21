import type { KnownBlock } from "@slack/types";
import { ChannelDeliveryError } from "@vellumai/gateway-client/http-delivery";

import { getLogger } from "../../../util/logger.js";
import type { ChannelTransport } from "../channel-transport.js";
import {
  sendSlackAgentSessionStatus,
  sendSlackAttachments,
  sendSlackReply,
  sendSlackStreamOp,
  updateSlackMessage,
} from "./send.js";

const log = getLogger("slack-transport");

/** Slack's rendering of a settled message. */
function mutedBlocks(text: string): KnownBlock[] {
  return [{ type: "context", elements: [{ type: "mrkdwn", text }] }];
}

export const slackTransport: ChannelTransport = {
  channel: "slack",

  async deliver(ctx, payload) {
    const { chatId, text, attachments } = payload;
    const threadTs = ctx.params.threadTs;

    let sentTs: string | undefined;
    if (text) {
      const result = await sendSlackReply(chatId, text, {
        threadTs,
        approval: payload.approval,
        useBlocks: payload.renderRichly,
        audience: payload.audience,
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

  async edit(_ctx, target) {
    const result = await updateSlackMessage(
      target.chatId,
      target.messageId,
      target.text,
      {
        // Slack's answer to a settled message is a context block, which reads
        // smaller and greyer than body text.
        blocks:
          target.emphasis === "muted" ? mutedBlocks(target.text) : undefined,
        useBlocks: target.renderRichly,
      },
    );
    return { ok: true, ts: result.ts };
  },

  async setActivity(ctx, target) {
    const ok = await sendSlackAgentSessionStatus({
      channel: target.chatId,
      phase: target.phase,
      threadTs: ctx.params.threadTs,
      messageTs: ctx.params.messageTs,
      initiatorUserId: target.initiatorUserId,
    });
    return { ok };
  },

  async streamReply(_ctx, chatId, op) {
    return sendSlackStreamOp(chatId, op);
  },
};
