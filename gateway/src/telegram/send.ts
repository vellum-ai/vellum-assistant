import type { ConfigFileCache } from "../config-file-cache.js";
import type { GatewayConfig } from "../config.js";
import type { CredentialCache } from "../credential-cache.js";
import type { ApprovalPayload } from "../http/routes/telegram-deliver.js";
import { getLogger } from "../logger.js";
import {
  downloadAttachment,
  type RuntimeAttachmentMeta,
} from "../runtime/client.js";
import { splitText } from "../util/split-text.js";
import { callTelegramApi, callTelegramApiMultipart } from "./api.js";

const log = getLogger("telegram-send");

export interface TelegramSendResult {
  messageId: number;
}

const TELEGRAM_MAX_MESSAGE_LEN = 4000;

/** Telegram Bot API enforces a 1-64 byte limit on InlineKeyboardButton callback_data. */
export const TELEGRAM_MAX_CALLBACK_DATA_BYTES = 64;

const IMAGE_MIME_PREFIXES = [
  "image/jpeg",
  "image/png",
  "image/gif",
  "image/webp",
];

export function buildInlineKeyboard(approval: ApprovalPayload): {
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

export async function sendTelegramReply(
  config: GatewayConfig,
  chatId: string,
  text: string,
  approval?: ApprovalPayload,
  opts?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
): Promise<TelegramSendResult> {
  const chunks = splitText(text, TELEGRAM_MAX_MESSAGE_LEN);

  let lastResult: { message_id: number } | undefined;
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

    lastResult = await callTelegramApi<{ message_id: number }>(
      "sendMessage",
      payload,
      opts,
    );
  }

  log.debug({ chatId, chunks: chunks.length }, "Telegram reply sent");
  return { messageId: lastResult!.message_id };
}

export async function sendTelegramAttachments(
  config: GatewayConfig,
  chatId: string,
  attachments: RuntimeAttachmentMeta[],
  opts?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
): Promise<void> {
  const failures: string[] = [];

  for (const meta of attachments) {
    // When size is known upfront, skip oversized attachments before downloading.
    if (
      meta.sizeBytes !== undefined &&
      meta.sizeBytes > config.maxAttachmentBytes
    ) {
      log.warn(
        { attachmentId: meta.id, sizeBytes: meta.sizeBytes },
        "Skipping oversized outbound attachment",
      );
      failures.push(meta.filename ?? meta.id);
      continue;
    }

    try {
      const payload = await downloadAttachment(config, meta.id);

      // Hydrate missing metadata from the downloaded payload so that
      // ID-only attachment payloads work correctly. Explicit meta fields
      // take precedence over downloaded values.
      const mimeType =
        meta.mimeType ?? payload.mimeType ?? "application/octet-stream";
      const filename = meta.filename ?? payload.filename ?? meta.id;
      const buffer = Buffer.from(payload.data, "base64");
      const sizeBytes = meta.sizeBytes ?? payload.sizeBytes ?? buffer.length;

      // Check size after hydration for ID-only payloads where size was unknown.
      if (sizeBytes > config.maxAttachmentBytes) {
        log.warn(
          { attachmentId: meta.id, sizeBytes },
          "Skipping oversized outbound attachment (detected after download)",
        );
        failures.push(filename);
        continue;
      }

      const blob = new Blob([buffer], { type: mimeType });

      const form = new FormData();
      form.set("chat_id", chatId);

      const isImage = IMAGE_MIME_PREFIXES.some((p) => mimeType.startsWith(p));
      if (isImage) {
        form.set("photo", blob, filename);
        await callTelegramApiMultipart("sendPhoto", form, opts);
      } else {
        form.set("document", blob, filename);
        await callTelegramApiMultipart("sendDocument", form, opts);
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
      await sendTelegramReply(config, chatId, notice, undefined, opts);
    } catch (err) {
      log.error({ err, chatId }, "Failed to send attachment failure notice");
    }
  }
}

export async function sendTypingIndicator(
  config: GatewayConfig,
  chatId: string,
  opts?: { credentials?: CredentialCache; configFile?: ConfigFileCache },
): Promise<boolean> {
  try {
    await callTelegramApi(
      "sendChatAction",
      {
        chat_id: chatId,
        action: "typing",
      },
      opts,
    );
    return true;
  } catch (err) {
    log.debug({ err, chatId }, "Failed to send typing indicator");
    return false;
  }
}
