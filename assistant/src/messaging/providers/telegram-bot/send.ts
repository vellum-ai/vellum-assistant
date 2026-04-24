/**
 * Telegram outbound message orchestration.
 *
 * Handles text splitting, approval inline keyboards, attachment delivery,
 * and typing indicators by calling the Telegram Bot API directly via ./api.ts.
 */

import type { ApprovalUIMetadata } from "@vellumai/gateway-client";

import * as attachmentsStore from "../../../memory/attachments-store.js";
import type { RuntimeAttachmentMetadata } from "../../../runtime/http-types.js";
import { getLogger } from "../../../util/logger.js";
import { callTelegramBotApi, callTelegramBotApiMultipart } from "./api.js";

const log = getLogger("telegram-send");

// Telegram Bot API supports up to 4096 characters per sendMessage call,
// but the gateway uses 4000 as the safe limit — mirror that.
const TELEGRAM_MAX_MESSAGE_LEN = 4000;

/** Telegram Bot API enforces a 1-64 byte limit on InlineKeyboardButton callback_data. */
const TELEGRAM_MAX_CALLBACK_DATA_BYTES = 64;

// Telegram Bot API sendDocument upload limit is 50 MB
const TELEGRAM_MAX_ATTACHMENT_BYTES = 50 * 1024 * 1024;

const TELEGRAM_IMAGE_MIME_PREFIXES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

// ---------------------------------------------------------------------------
// Text splitting
// ---------------------------------------------------------------------------

function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + maxLen, text.length);
    // Avoid splitting a surrogate pair
    if (
      end < text.length &&
      text.charCodeAt(end - 1) >= 0xd800 &&
      text.charCodeAt(end - 1) <= 0xdbff
    ) {
      end--;
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

// ---------------------------------------------------------------------------
// Inline keyboard (approval buttons)
// ---------------------------------------------------------------------------

function buildInlineKeyboard(approval: ApprovalUIMetadata): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: approval.actions.map((action) => {
      const callbackData = `apr:${approval.requestId}:${action.id}`;
      if (Buffer.byteLength(callbackData) > TELEGRAM_MAX_CALLBACK_DATA_BYTES) {
        throw new Error(
          `callback_data for action "${action.id}" is ${Buffer.byteLength(callbackData)} bytes, exceeding Telegram's ${TELEGRAM_MAX_CALLBACK_DATA_BYTES}-byte limit`,
        );
      }
      return [
        {
          text: action.label,
          callback_data: callbackData,
        },
      ];
    }),
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Send a Telegram text reply, splitting long messages and optionally
 * attaching inline keyboard buttons for approval prompts.
 */
export async function sendTelegramReply(
  chatId: string,
  text: string,
  approval?: ApprovalUIMetadata,
): Promise<void> {
  const chunks = splitText(text, TELEGRAM_MAX_MESSAGE_LEN);

  for (let i = 0; i < chunks.length; i++) {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
    };

    // Attach inline keyboard only to the last chunk so buttons appear after
    // the full message text.
    if (approval && i === chunks.length - 1) {
      payload.reply_markup = buildInlineKeyboard(approval);
    }

    await callTelegramBotApi("sendMessage", payload);
  }

  log.debug({ chatId, chunks: chunks.length }, "Telegram reply sent");
}

export type TelegramAttachmentResult = {
  allFailed: boolean;
  failureCount: number;
  totalCount: number;
};

/**
 * Send attachments to a Telegram chat, using sendPhoto for images and
 * sendDocument for everything else.
 */
export async function sendTelegramAttachments(
  chatId: string,
  attachments: RuntimeAttachmentMetadata[],
): Promise<TelegramAttachmentResult> {
  const failures: string[] = [];

  for (const meta of attachments) {
    // Skip oversized attachments when size is known upfront
    if (
      meta.sizeBytes !== undefined &&
      meta.sizeBytes > TELEGRAM_MAX_ATTACHMENT_BYTES
    ) {
      log.warn(
        { attachmentId: meta.id, sizeBytes: meta.sizeBytes },
        "Skipping oversized outbound attachment",
      );
      failures.push(meta.filename ?? meta.id);
      continue;
    }

    try {
      const content = attachmentsStore.getAttachmentContent(meta.id);
      if (!content) {
        log.error(
          { attachmentId: meta.id },
          "Attachment content not found in store",
        );
        failures.push(meta.filename ?? meta.id);
        continue;
      }

      const mimeType = meta.mimeType ?? "application/octet-stream";
      const filename = meta.filename ?? meta.id;

      if (content.length > TELEGRAM_MAX_ATTACHMENT_BYTES) {
        log.warn(
          { attachmentId: meta.id, sizeBytes: content.length },
          "Skipping oversized outbound attachment (detected after read)",
        );
        failures.push(filename);
        continue;
      }

      const blob = new Blob([new Uint8Array(content)], { type: mimeType });
      const form = new FormData();
      form.set("chat_id", chatId);

      const isImage = TELEGRAM_IMAGE_MIME_PREFIXES.some((p) =>
        mimeType.startsWith(p),
      );
      if (isImage) {
        form.set("photo", blob, filename);
        await callTelegramBotApiMultipart("sendPhoto", form);
      } else {
        form.set("document", blob, filename);
        await callTelegramBotApiMultipart("sendDocument", form);
      }

      log.debug(
        { chatId, attachmentId: meta.id, filename },
        "Attachment sent to Telegram",
      );
    } catch (err) {
      const displayName = meta.filename ?? meta.id;
      log.error(
        { err, attachmentId: meta.id, filename: displayName },
        "Failed to send attachment to Telegram",
      );
      failures.push(displayName);
    }
  }

  if (failures.length > 0) {
    const notice = `\u26a0\ufe0f ${failures.length} attachment(s) could not be delivered: ${failures.join(", ")}`;
    try {
      await sendTelegramReply(chatId, notice);
    } catch (err) {
      log.error({ err, chatId }, "Failed to send attachment failure notice");
    }
  }

  return {
    allFailed: failures.length === attachments.length,
    failureCount: failures.length,
    totalCount: attachments.length,
  };
}

/**
 * Send a typing indicator ("chat action") to a Telegram chat.
 * Returns true on success, false on failure (non-throwing).
 */
export async function sendTelegramTypingIndicator(
  chatId: string,
): Promise<boolean> {
  try {
    await callTelegramBotApi("sendChatAction", {
      chat_id: chatId,
      action: "typing",
    });
    return true;
  } catch (err) {
    log.debug({ err, chatId }, "Failed to send typing indicator");
    return false;
  }
}
