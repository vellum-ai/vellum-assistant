import type { GatewayConfig } from "../config.js";
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

export async function sendTelegramReply(
  config: GatewayConfig,
  chatId: string,
  text: string,
): Promise<void> {
  const chunks = splitText(text);

  for (const chunk of chunks) {
    await callTelegramApi(config, "sendMessage", {
      chat_id: chatId,
      text: chunk,
    });
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
    if (meta.sizeBytes > config.maxAttachmentBytes) {
      log.warn({ attachmentId: meta.id, sizeBytes: meta.sizeBytes }, "Skipping oversized outbound attachment");
      failures.push(meta.filename);
      continue;
    }

    try {
      // Use the legacy assistant-scoped download path when assistantId is
      // available; fall back to the assistant-less endpoint otherwise.
      const payload = assistantId
        ? await downloadAttachment(config, assistantId, meta.id)
        : await downloadAttachmentById(config, meta.id);
      const buffer = Buffer.from(payload.data, "base64");
      const blob = new Blob([buffer], { type: meta.mimeType });

      const form = new FormData();
      form.set("chat_id", chatId);

      const isImage = IMAGE_MIME_PREFIXES.some((p) => meta.mimeType.startsWith(p));
      if (isImage) {
        form.set("photo", blob, meta.filename);
        await callTelegramApiMultipart(config, "sendPhoto", form);
      } else {
        form.set("document", blob, meta.filename);
        await callTelegramApiMultipart(config, "sendDocument", form);
      }

      log.debug({ chatId, attachmentId: meta.id, filename: meta.filename }, "Attachment sent to Telegram");
    } catch (err) {
      log.error({ err, attachmentId: meta.id, filename: meta.filename }, "Failed to send attachment to Telegram");
      failures.push(meta.filename);
    }
  }

  if (failures.length > 0) {
    const notice = `⚠️ ${failures.length} attachment(s) could not be delivered: ${failures.join(", ")}`;
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
