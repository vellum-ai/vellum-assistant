import type { KnownBlock } from "@slack/types";
import { ChannelDeliveryError } from "@vellumai/gateway-client/http-delivery";

import { extractThreadTsFromCallbackUrl } from "../../../channels/slack-callback-url.js";
import { getLogger } from "../../../util/logger.js";
import type { ChannelTransport } from "../channel-transport.js";
import { SLACK_STREAM_MARKDOWN_LIMIT } from "./api.js";
import {
  sendSlackAgentSessionStatus,
  sendSlackAttachments,
  sendSlackReaction,
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

  async react(target) {
    return sendSlackReaction(
      target.chatId,
      target.emoji,
      target.messageId,
      target.action,
    );
  },

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

  // `chat.startStream` and `chat.appendStream` both cap `markdown_text`, so
  // the caller splits a wider delta and advances its delivered mark once per
  // operation this transport confirms.
  maxStreamTextChars: SLACK_STREAM_MARKDOWN_LIMIT,

  // `chat.stopStream` finalizes the streamed message in place, so what the
  // stream leaves behind IS the reply and durable delivery must not resend it.
  streamPersists: true,

  /**
   * `chat.startStream` streams into a thread, so a turn with no thread to
   * open under cannot stream. Resolving that here, from this channel's own
   * callback, is what keeps Slack's addressing out of the shared session:
   * a start with no thread reports not-ok and the caller sends the finished
   * reply instead.
   */
  async streamReply(ctx, chatId, op) {
    if (op.action !== "start") {
      return sendSlackStreamOp(chatId, op);
    }
    const threadTs =
      op.anchorMessageId ?? extractThreadTsFromCallbackUrl(ctx.callbackUrl);
    if (!threadTs) {
      return { ok: false };
    }
    return sendSlackStreamOp(chatId, { ...op, anchorMessageId: threadTs });
  },
};
