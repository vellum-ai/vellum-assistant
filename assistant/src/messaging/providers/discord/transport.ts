import { ChannelDeliveryError } from "@vellumai/gateway-client/http-delivery";

import { getLogger } from "../../../util/logger.js";
import type {
  CallbackContext,
  ChannelTransport,
} from "../channel-transport.js";
import { isBusyActivityPhase } from "../channel-transport.js";
import { openDiscordDmChannel } from "./api.js";
import type { DiscordSendTarget } from "./send.js";
import {
  editDiscordMessage,
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
 * The `dm` param inverts what `chatId` means: it marks the value as a
 * *recipient user* snowflake to be reached privately, which is resolved to a
 * DM channel here. Callers that address a person rather than a room set it,
 * because a Discord user id and a channel id are both bare snowflakes and
 * nothing in the value itself says which one arrived.
 *
 * `channel` and `threadId` are the only coordinates delivery needs;
 * `POST /channels/{id}/messages` addresses a channel and nothing more.
 */
async function sendTarget(
  ctx: CallbackContext,
  chatId: string,
): Promise<DiscordSendTarget> {
  if (ctx.params.dm === "1") {
    return { channelId: await openDiscordDmChannel(chatId) };
  }
  return { channelId: ctx.params.threadId?.trim() || chatId };
}

export const discordTransport: ChannelTransport = {
  channel: "discord",

  // Discord clears a typing indicator after ten seconds.
  activityRefreshMs: 8_000,

  async edit(ctx, target) {
    await editDiscordMessage(
      await sendTarget(ctx, target.chatId),
      target.messageId,
      target.text,
      { ...(target.emphasis ? { emphasis: target.emphasis } : {}) },
    );
    return { ok: true };
  },

  async setActivity(ctx, target) {
    // Discord's typing indicator expires by itself after ten seconds, so a
    // phase that is not running needs no clearing call.
    if (!isBusyActivityPhase(target.phase)) {
      return { ok: true };
    }
    await sendDiscordTypingIndicator(await sendTarget(ctx, target.chatId));
    log.debug(
      { chatId: target.chatId, phase: target.phase },
      "Discord typing indicator delivered (direct)",
    );
    return { ok: true };
  },

  async deliver(ctx, payload) {
    const { chatId, text, attachments, approval } = payload;
    const target = await sendTarget(ctx, chatId);

    let sentId: string | undefined;
    if (text) {
      const result = await sendDiscordReply(target, text);
      sentId = result.lastMessageId;
    } else if (approval) {
      // Approvals deliver as plain text, so the prompt is readable but not
      // clickable. Discord is not a guardian channel: approval prompts are
      // actioned from the guardian's own channel, not from here.
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
    return { ok: true, ts: sentId };
  },
};
