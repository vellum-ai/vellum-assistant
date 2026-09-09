import type { StreamPlan, StreamPlanStep } from "@vellumai/gateway-client";
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
  sendTelegramMessageDraft,
  sendTelegramReaction,
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

/**
 * A plan drawn into the draft's own text, because Telegram has no task
 * primitive a bot may use: `sendChecklist` is business-account only. Rendering
 * it here rather than above the seam is the point of the seam. The glyphs
 * carry the status without a legend, and a step keeps its place as it
 * advances so the reader watches one list move rather than a new one appear.
 */
function renderPlanAsText(plan: StreamPlan): string {
  const glyph: Record<StreamPlanStep["status"], string> = {
    completed: "\u2713",
    in_progress: "\u25b8",
    pending: "\u00b7",
    failed: "\u2717",
  };
  const lines = plan.steps.map((step) => `${glyph[step.status]} ${step.label}`);
  return [plan.title, ...lines].filter(Boolean).join("\n");
}

/** The draft's whole text: the reply so far, with any plan beneath it. */
function draftText(text: string, plan: StreamPlan | undefined): string {
  const body = text.trim();
  const planText = plan ? renderPlanAsText(plan) : "";
  return [body, planText].filter(Boolean).join("\n\n");
}

/**
 * Telegram's draft id is minted by the caller, unlike a stream id a platform
 * hands back, and only has to be non-zero and stable for the life of one
 * draft. The clock supplies that without any state to keep between calls.
 */
function mintDraftId(): number {
  return Date.now();
}

export const telegramTransport: ChannelTransport = {
  channel: "telegram",

  // Telegram clears a chat action after about five seconds.
  activityRefreshMs: 4_000,

  // The draft is a preview: it expires on its own, and the moment the bot
  // sends the real message, so the reply is still owed after the stream ends.
  streamPersists: false,

  async react(target) {
    return sendTelegramReaction(
      target.chatId,
      target.emoji,
      target.messageId,
      target.action,
    );
  },

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

  /**
   * Show the reply as it is written, in Telegram's own live draft.
   *
   * Every call carries the whole partial reply rather than a delta: Telegram
   * animates the difference between drafts sharing a `draft_id`, so sending
   * only what is new would replace the draft with the fragment. `stop` has
   * nothing to do, since the draft clears itself when the real reply sends.
   *
   * A start that Telegram refuses (a chat that is not private, where drafts
   * are not offered) reports not-ok, and the caller falls back to sending the
   * finished reply. That is the whole of the per-conversation rule: it is
   * answered here, where the platform's constraint lives.
   */
  async streamReply(ctx, chatId, op) {
    const opts = threadOptions(ctx);
    if (op.action === "stop") {
      return { ok: true, ts: op.streamId };
    }
    const draftId = op.action === "start" ? mintDraftId() : Number(op.streamId);
    if (!Number.isFinite(draftId) || draftId === 0) {
      return { ok: false };
    }
    const sent = await sendTelegramMessageDraft(
      chatId,
      draftId,
      draftText(op.text, op.plan),
      opts,
    );
    return sent ? { ok: true, ts: String(draftId) } : { ok: false };
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
