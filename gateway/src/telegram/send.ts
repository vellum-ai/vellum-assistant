import type { GatewayConfig } from "../config.js";
import type { ApprovalPayload } from "../http/routes/telegram-deliver.js";
import { getLogger } from "../logger.js";
import { downloadAttachment, downloadAttachmentById, type RuntimeAttachmentMeta } from "../runtime/client.js";
import { callTelegramApi, callTelegramApiMultipart } from "./api.js";

const log = getLogger("telegram-send");

const TELEGRAM_MAX_MESSAGE_LEN = 4000;

const IMAGE_MIME_PREFIXES = ["image/jpeg", "image/png", "image/gif", "image/webp"];

function splitText(text: string): string[] {
  if (text.length <= TELEGRAM_MAX_MESSAGE_LEN) {
    return [text];
  }

  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < text.length) {
    let end = Math.min(cursor + TELEGRAM_MAX_MESSAGE_LEN, text.length);
    // Avoid splitting a surrogate pair
    if (end < text.length && text.charCodeAt(end - 1) >= 0xd800 && text.charCodeAt(end - 1) <= 0xdbff) {
      end--;
    }
    chunks.push(text.slice(cursor, end));
    cursor = end;
  }
  return chunks;
}

export function buildInlineKeyboard(
  approval: ApprovalPayload,
): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return {
    inline_keyboard: approval.actions.map((action) => [
      {
        text: action.label,
        callback_data: `apr:${approval.runId}:${action.id}`,
      },
    ]),
  };
}

export async function sendTelegramReply(
  config: GatewayConfig,
  chatId: string,
  text: string,
  approval?: ApprovalPayload,
): Promise<void> {
  const chunks = splitText(text);

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

    await callTelegramApi(config, "sendMessage", payload);
  }

  log.debug({ chatId, chunks: chunks.length }, "Telegram reply sent");
}

export async function sendTelegramAttachments(
  config: GatewayConfig,
  chatId: string,
  assistantId: string | undefined,
  attachments: RuntimeAttachmentMeta[],
): Promise<void> {
  const failures: string[] = [];

  for (const meta of attachments) {
    // When size is known upfront, skip oversized attachments before downloading.
    if (meta.sizeBytes !== undefined && meta.sizeBytes > config.maxAttachmentBytes) {
      log.warn({ attachmentId: meta.id, sizeBytes: meta.sizeBytes }, "Skipping oversized outbound attachment");
      failures.push(meta.filename ?? meta.id);
      continue;
    }

    try {
      // Use the legacy assistant-scoped download path when assistantId is
      // available; fall back to the assistant-less endpoint otherwise.
      const payload = assistantId
        ? await downloadAttachment(config, assistantId, meta.id)
        : await downloadAttachmentById(config, meta.id);

      // Hydrate missing metadata from the downloaded payload so that
      // ID-only attachment payloads work correctly. Explicit meta fields
      // take precedence over downloaded values.
      const mimeType = meta.mimeType ?? payload.mimeType ?? "application/octet-stream";
      const filename = meta.filename ?? payload.filename ?? meta.id;
      const buffer = Buffer.from(payload.data, "base64");
      const sizeBytes = meta.sizeBytes ?? payload.sizeBytes ?? buffer.length;

      // Check size after hydration for ID-only payloads where size was unknown.
      if (sizeBytes > config.maxAttachmentBytes) {
        log.warn({ attachmentId: meta.id, sizeBytes }, "Skipping oversized outbound attachment (detected after download)");
        failures.push(filename);
        continue;
      }

      const blob = new Blob([buffer], { type: mimeType });

      const form = new FormData();
      form.set("chat_id", chatId);

      const isImage = IMAGE_MIME_PREFIXES.some((p) => mimeType.startsWith(p));
      if (isImage) {
        form.set("photo", blob, filename);
        await callTelegramApiMultipart(config, "sendPhoto", form);
      } else {
        form.set("document", blob, filename);
        await callTelegramApiMultipart(config, "sendDocument", form);
      }

      log.debug({ chatId, attachmentId: meta.id, filename }, "Attachment sent to Telegram");
    } catch (err) {
      const displayName = meta.filename ?? meta.id;
      log.error({ err, attachmentId: meta.id, filename: displayName }, "Failed to send attachment to Telegram");
      failures.push(displayName);
    }
  }

  if (failures.length > 0) {
    const notice = `\u26a0\ufe0f ${failures.length} attachment(s) could not be delivered: ${failures.join(", ")}`;
    try {
      await sendTelegramReply(config, chatId, notice);
    } catch (err) {
      log.error({ err, chatId }, "Failed to send attachment failure notice");
    }
  }
}

export async function sendTypingIndicator(config: GatewayConfig, chatId: string): Promise<boolean> {
  try {
    await callTelegramApi(config, "sendChatAction", { chat_id: chatId, action: "typing" });
    return true;
  } catch (err) {
    log.debug({ err, chatId }, "Failed to send typing indicator");
    return false;
  }
}

export { splitText };
