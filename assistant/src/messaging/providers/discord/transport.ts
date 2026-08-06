import { ChannelDeliveryError } from "@vellumai/gateway-client/http-delivery";

import { getLogger } from "../../../util/logger.js";
import type {
  CallbackContext,
  ChannelTransport,
} from "../channel-transport.js";
import type { DiscordSendTarget } from "./send.js";
import {
  sendDiscordAttachments,
  sendDiscordReply,
  sendDiscordTypingIndicator,
} from "./send.js";

const log = getLogger("discord-transport");

/**
 * Resolve where a reply is posted.
 *
 * The gateway normalizer sets `conversationExternalId` (which arrives as
 * `payload.chatId`) to the *parent* channel for a thread message, mirroring
 * Slack's channel + thread_ts split, and carries the thread's own snowflake on
 * the callback URL's `threadId` param. A Discord thread is itself a channel,
 * so a threaded reply posts to the thread id and everything else to the
 * channel id.
 *
 * These two coordinates are the delivery-bearing half of the Discord address
 * shape fixtured on LUM-2911 (`application + guild + channel + threadId`); the
 * names here are kept identical so a future channel-address contract can adopt
 * them rather than migrate off different ones. `application` and `guild` are
 * not encoded because `POST /channels/{id}/messages` does not need them, and a
 * param nothing reads is debt.
 */
function sendTarget(ctx: CallbackContext, chatId: string): DiscordSendTarget {
  const threadId = ctx.params.threadId?.trim();
  return { channelId: threadId ? threadId : chatId };
}

export const discordTransport: ChannelTransport = {
  channel: "discord",

  async deliver(ctx, payload) {
    const { chatId, text, attachments, approval } = payload;
    const target = sendTarget(ctx, chatId);

    let sentId: string | undefined;
    if (text) {
      const result = await sendDiscordReply(target, text);
      sentId = result.lastMessageId;
    } else if (approval) {
      // Approvals deliver as plain text: interactive components are out of
      // this slice, so the prompt is readable but not clickable here. Discord
      // is not a guardian channel, so approval prompts escalate to the
      // guardian's own channel rather than being actioned from Discord.
      const result = await sendDiscordReply(
        target,
        approval.plainTextFallback || "Approval required",
      );
      sentId = result.lastMessageId;
    }

    if (attachments && attachments.length > 0) {
      const result = await sendDiscordAttachments(target, attachments);
      if (result.allFailed && !text) {
        throw new ChannelDeliveryError(
          502,
          `All ${result.failureCount} attachments failed to deliver`,
        );
      }
    }

    log.info(
      { channelId: target.channelId, hasText: !!text },
      "Discord reply delivered (direct)",
    );
    return sentId !== undefined ? { ok: true, ts: sentId } : { ok: true };
  },

  async sendTyping(ctx, payload) {
    await sendDiscordTypingIndicator(sendTarget(ctx, payload.chatId));
    return { ok: true };
  },
};
