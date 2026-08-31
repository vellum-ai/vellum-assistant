/**
 * Withdraw a Telegram approval card when its underlying guardian request
 * resolves.
 *
 * Telegram bots cannot re-read a delivered message, so the Slack shape
 * (fetch the original content, strip the buttons, append a status line in
 * one edit) is not available here. The closest faithful projection is:
 *
 *   1. Remove the inline keyboard in place (`editMessageReplyMarkup`), which
 *      preserves the card's text for the audit trail while dropping every
 *      live affordance.
 *   2. Post the terminal outcome as a silent reply quoting the card, so the
 *      message thread durably shows what was decided. The reply is skipped
 *      when the decision originated on Telegram: the guardian reply router
 *      already delivers its own outcome message in that chat, and a second
 *      notice would read as a duplicate.
 *
 * Bot API wrappers differ on the "remove markup" form, so the edit tries the
 * explicit `null` first and falls back to an empty inline keyboard, mirroring
 * the gateway's callback-time clearing. "message is not modified" means the
 * keyboard is already gone (e.g. the gateway cleared it when the deciding tap
 * arrived) and is treated as success. Unlike the gateway's tap path, a failed
 * edit never deletes the message: withdrawal must preserve the audit trail,
 * and a tap on a leftover button already gets the stale "already resolved"
 * handling.
 */

import {
  isParkAction,
  resolveDecisionStatusWord,
} from "../../../runtime/channel-approval-types.js";
import { getLogger } from "../../../util/logger.js";
import { callTelegramBotApi } from "./api.js";

const log = getLogger("telegram-withdraw");

const STATUS_GLYPH: Record<string, string> = {
  approved: "✅",
  denied: "❌",
  expired: "⌛",
  cancelled: "\u{1f6ab}",
};

/**
 * Glyph for a parked (leave-unverified) decision: a neutral "on hold" mark
 * rather than the `denied` cross, since the sender was neither trusted nor
 * kept out.
 */
const PARK_STATUS_GLYPH = "⏸️";

export interface WithdrawTelegramApprovalCardParams {
  /** Telegram chat the approval message lives in. */
  chatId: string;
  /** Channel-native id of the approval message to withdraw. */
  messageId: string;
  /** Terminal status of the request (e.g. "approved", "denied", "expired"). */
  status: string;
  /**
   * The action the guardian took, when known. A `denied` status reached by a
   * park action (`leave_unverified`) reads as the neutral park label (see
   * {@link resolveDecisionStatusWord}) rather than "Denied"; `block`/`reject`
   * stay a denial. Omitted for status-only transitions (e.g. the expiry
   * sweep).
   */
  decidedAction?: string;
  /**
   * Whether to post the quoted status reply. False when the decision
   * originated on Telegram, where the guardian reply router already delivers
   * the outcome message in the same chat.
   */
  postStatusReply: boolean;
}

/** Build the plain-text outcome line for the quoted status reply. */
function buildStatusText(status: string, decidedAction?: string): string {
  const park = status === "denied" && isParkAction(decidedAction);
  const glyph = park ? PARK_STATUS_GLYPH : (STATUS_GLYPH[status] ?? "");
  const word = resolveDecisionStatusWord(status, decidedAction);
  return glyph ? `${glyph} ${word}` : word;
}

/** True for the Bot API's "message is not modified" no-op edit rejection. */
function isNoOpMarkupError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.includes("message is not modified");
}

/**
 * Remove the card's inline keyboard in place, keeping its text. Tries the
 * explicit `reply_markup: null` form first, then an empty inline keyboard.
 * Returns true when the keyboard is gone (including the already-cleared
 * no-op case); false when both edit forms failed.
 */
async function clearInlineKeyboard(
  chatId: string,
  messageId: number,
): Promise<boolean> {
  const basePayload = { chat_id: chatId, message_id: messageId };
  try {
    await callTelegramBotApi("editMessageReplyMarkup", {
      ...basePayload,
      reply_markup: null,
    });
    return true;
  } catch (primaryErr) {
    if (isNoOpMarkupError(primaryErr)) {
      return true;
    }
    try {
      await callTelegramBotApi("editMessageReplyMarkup", {
        ...basePayload,
        reply_markup: { inline_keyboard: [] },
      });
      return true;
    } catch (fallbackErr) {
      if (isNoOpMarkupError(fallbackErr)) {
        return true;
      }
      log.warn(
        { primaryErr, fallbackErr, chatId, messageId },
        "Failed to clear inline keyboard on resolved Telegram approval card",
      );
      return false;
    }
  }
}

/**
 * Project a resolved guardian request onto its Telegram approval card:
 * drop the inline keyboard in place and (unless suppressed) post a silent
 * reply quoting the card with the terminal outcome.
 *
 * Both steps are attempted independently, so a failed keyboard edit does not
 * lose the durable outcome notice. Throws only if the status reply send
 * fails, which decision-path callers treat as non-fatal. `complete` reports
 * whether the keyboard is durably gone: false keeps the expiry sweep's
 * receipt held back so the still-actionable card is retried. An invalid
 * recorded message id reports complete, because no retry can ever address
 * it; a tap on its leftover buttons gets the stale-request handling.
 */
export async function withdrawTelegramApprovalCard(
  params: WithdrawTelegramApprovalCardParams,
): Promise<{ complete: boolean }> {
  const parsedMessageId = Number(params.messageId);
  if (!Number.isFinite(parsedMessageId)) {
    log.warn(
      { chatId: params.chatId, messageId: params.messageId },
      "Skipping Telegram card withdrawal due to invalid message id",
    );
    return { complete: true };
  }

  const keyboardCleared = await clearInlineKeyboard(
    params.chatId,
    parsedMessageId,
  );

  if (!params.postStatusReply) {
    return { complete: keyboardCleared };
  }

  // Silent (no push) reply quoting the card. `allow_sending_without_reply`
  // keeps the outcome notice deliverable even if the card was deleted.
  await callTelegramBotApi("sendMessage", {
    chat_id: params.chatId,
    text: buildStatusText(params.status, params.decidedAction),
    reply_parameters: {
      message_id: parsedMessageId,
      allow_sending_without_reply: true,
    },
    disable_notification: true,
  });
  return { complete: keyboardCleared };
}
