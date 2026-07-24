/**
 * Telegram outbound message orchestration.
 *
 * Handles text splitting, approval inline keyboards, attachment delivery,
 * and typing indicators by calling the Telegram Bot API directly via ./api.ts.
 */

import type {
  ApprovalUIMetadata,
  QuestionUIMetadata,
} from "@vellumai/gateway-client";

import { getAttachmentContent } from "../../../persistence/attachments-store.js";
import type { RuntimeAttachmentMetadata } from "../../../runtime/http-types.js";
import { getLogger } from "../../../util/logger.js";
import {
  callTelegramBotApi,
  callTelegramBotApiMultipart,
  type TelegramMessage,
  TelegramNonRetryableError,
} from "./api.js";
import { renderTelegramHtml } from "./render.js";

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

/**
 * Per-send options shared by the Telegram send helpers.
 *
 * `messageThreadId` targets a private-chat topic (the Telegram analog of a
 * Slack thread); omitted, the send lands in the main chat. The value is the
 * `message_thread_id` carried on the inbound update. Carried as a string
 * because it originates as a URL param and multipart sends need the string
 * form; payloads convert once in {@link threadIdPayloadFields}.
 */
export interface TelegramSendOptions {
  messageThreadId?: string;
}

/**
 * Topic-targeting field for a send payload, or undefined when the send
 * targets the main chat — spread into the payload literal.
 *
 * `message_thread_id` is the Bot API topic field for both forum supergroups
 * and private chats of bots with topic ("threaded") mode enabled — the same
 * field inbound updates carry. (`direct_messages_topic_id` is a different
 * surface — channel direct-messages/monoforum chats — and is not used here.)
 */
function threadIdPayloadFields(
  opts?: TelegramSendOptions,
): { message_thread_id: number } | undefined {
  const id = opts?.messageThreadId?.trim();
  return id ? { message_thread_id: Number(id) } : undefined;
}

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
// Inline keyboards (approval + question buttons)
// ---------------------------------------------------------------------------

/** Telegram rejects a send whose callback_data exceeds 64 bytes; fail loudly at
 *  build time rather than let the Bot API reject the whole message. */
function assertCallbackDataWithinLimit(
  callbackData: string,
  label: string,
): void {
  const bytes = Buffer.byteLength(callbackData);
  if (bytes > TELEGRAM_MAX_CALLBACK_DATA_BYTES) {
    throw new Error(
      `callback_data for ${label} is ${bytes} bytes, exceeding Telegram's ${TELEGRAM_MAX_CALLBACK_DATA_BYTES}-byte limit`,
    );
  }
}

function buildInlineKeyboard(approval: ApprovalUIMetadata): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  return {
    inline_keyboard: approval.actions.map((action) => {
      const callbackData = `apr:${approval.requestId}:${action.id}`;
      assertCallbackDataWithinLimit(callbackData, `action "${action.id}"`);
      return [{ text: action.label, callback_data: callbackData }];
    }),
  };
}

/**
 * Inline keyboard for the current step of a channel-native question wizard: one
 * button per option, then a Skip button. The metadata carries a single question
 * entry (the daemon delivers one wizard step at a time). Callbacks encode
 * `qst:<requestId>:<questionId>:<optionIndex>` (or `:skip`) — the raw option id
 * never crosses the wire; it is resolved server-side from the index.
 */
function buildQuestionKeyboard(question: QuestionUIMetadata): {
  inline_keyboard: Array<Array<{ text: string; callback_data: string }>>;
} {
  const entry = question.questions[0];
  if (!entry) {
    throw new Error("buildQuestionKeyboard requires a question entry");
  }
  const rows = entry.options.map((option, optIdx) => {
    const callbackData = `qst:${question.requestId}:${entry.id}:${optIdx}`;
    assertCallbackDataWithinLimit(callbackData, `option "${option.id}"`);
    return [{ text: option.label, callback_data: callbackData }];
  });
  const skipData = `qst:${question.requestId}:${entry.id}:skip`;
  assertCallbackDataWithinLimit(skipData, "skip");
  rows.push([{ text: "Skip", callback_data: skipData }]);
  return { inline_keyboard: rows };
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
  opts?: TelegramSendOptions,
): Promise<void> {
  const chunks = splitText(text, TELEGRAM_MAX_MESSAGE_LEN);

  for (let i = 0; i < chunks.length; i++) {
    const payload: Record<string, unknown> = {
      chat_id: chatId,
      text: chunks[i],
      ...threadIdPayloadFields(opts),
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

/**
 * Send a Telegram reply as a rich message (Bot API 10.1) so tables, headings,
 * code, and quotes render natively. On a non-retryable rejection of the rich
 * send, fall back to the plain-text `sendTelegramReply` so the user still
 * receives the message.
 *
 * The canonical reply markdown is rendered to Telegram rich HTML (see
 * `render.ts`) and sent via `InputRichMessage.html`. HTML mode keeps text
 * content literal, so canonical GFM that overlaps Telegram's Rich *Markdown*
 * extensions (`$…$` math, `==highlight==`, `||spoiler||`) renders exactly as
 * written instead of being reinterpreted. `skip_entity_detection` is set
 * because the canonical parser already turns bare URLs and e-mails into links;
 * leaving Telegram's auto-detection on would additionally linkify cashtags,
 * hashtags, mentions, phone numbers, and bank-card-like digit runs that GFM
 * treats as plain text.
 *
 * Old clients degrade the display client-side; the send itself does not fail on
 * recipient version, so the only fallback trigger is a request-level rejection
 * (content over Telegram's documented rich-message limits, or a Bot API server
 * predating 10.1). The plain path splits at `TELEGRAM_MAX_MESSAGE_LEN`, so it
 * also covers the rare oversize case the single-shot rich send cannot.
 *
 * Wire shapes verified against the official Bot API docs:
 *   - sendRichMessage:  https://core.telegram.org/bots/api#sendrichmessage
 *   - InputRichMessage: https://core.telegram.org/bots/api#inputrichmessage
 *   - Rich HTML:        https://core.telegram.org/bots/api#rich-message-formatting-options
 */
export async function sendTelegramRichReply(
  chatId: string,
  markdown: string,
  approval?: ApprovalUIMetadata,
  opts?: TelegramSendOptions,
): Promise<void> {
  const html = renderTelegramHtml(markdown);
  if (html === undefined) {
    // No renderable rich content — send as plain text.
    await sendTelegramReply(chatId, markdown, approval, opts);
    return;
  }

  const payload: Record<string, unknown> = {
    chat_id: chatId,
    rich_message: { html, skip_entity_detection: true },
    ...threadIdPayloadFields(opts),
  };
  if (approval) {
    payload.reply_markup = buildInlineKeyboard(approval);
  }

  try {
    await callTelegramBotApi("sendRichMessage", payload);
    log.debug({ chatId }, "Telegram rich message sent");
  } catch (err) {
    if (err instanceof TelegramNonRetryableError) {
      log.warn(
        { chatId, description: err.description },
        "Telegram rejected rich message; falling back to plain text",
      );
      await sendTelegramReply(chatId, markdown, approval, opts);
      return;
    }
    throw err;
  }
}

/**
 * Deliver one step of a channel-native question wizard. Without `messageTs`,
 * send a fresh message and return its id so the wizard can edit it later; with
 * `messageTs`, edit that message in place to advance to the next question. Both
 * carry the option keyboard in a single Bot API call.
 */
export async function sendTelegramQuestion(
  chatId: string,
  text: string,
  question: QuestionUIMetadata,
  messageTs: string | undefined,
  opts?: TelegramSendOptions,
): Promise<string | undefined> {
  const replyMarkup = buildQuestionKeyboard(question);
  if (messageTs) {
    await callTelegramBotApi("editMessageText", {
      chat_id: chatId,
      message_id: Number(messageTs),
      text,
      reply_markup: replyMarkup,
    });
    return messageTs;
  }
  const result = await callTelegramBotApi<TelegramMessage>("sendMessage", {
    chat_id: chatId,
    text,
    reply_markup: replyMarkup,
    ...threadIdPayloadFields(opts),
  });
  return String(result.message_id);
}

/**
 * Edit an existing message's text and drop its inline keyboard in a single call
 * — used to finalize a question wizard (show the recorded answers, remove the
 * now-stale buttons). Omitting `reply_markup` on `editMessageText` clears it.
 */
export async function editTelegramMessageText(
  chatId: string,
  messageTs: string,
  text: string,
): Promise<void> {
  await callTelegramBotApi("editMessageText", {
    chat_id: chatId,
    message_id: Number(messageTs),
    text,
  });
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
  opts?: TelegramSendOptions,
): Promise<TelegramAttachmentResult> {
  const failures: string[] = [];
  const threadFields = threadIdPayloadFields(opts);

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
      const content = getAttachmentContent(meta.id);
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
      if (threadFields) {
        form.set("message_thread_id", String(threadFields.message_thread_id));
      }

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
      await sendTelegramReply(chatId, notice, undefined, opts);
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
  opts?: TelegramSendOptions,
): Promise<boolean> {
  try {
    await callTelegramBotApi("sendChatAction", {
      chat_id: chatId,
      action: "typing",
      ...threadIdPayloadFields(opts),
    });
    return true;
  } catch (err) {
    log.debug({ err, chatId }, "Failed to send typing indicator");
    return false;
  }
}
