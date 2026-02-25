import type { GatewayConfig } from "../config.js";
import { getLogger } from "../logger.js";
import { downloadAttachment, downloadAttachmentById, type RuntimeAttachmentMeta } from "../runtime/client.js";
import { splitText } from "../util/split-text.js";
import { sendWhatsAppTextMessage, uploadWhatsAppMedia, sendWhatsAppMediaMessage, type WhatsAppMediaType } from "./api.js";

const log = getLogger("whatsapp-send");

// WhatsApp supports up to 4096 characters per text message
const WHATSAPP_MAX_MESSAGE_LEN = 4096;

const IMAGE_MIME_PREFIXES = ["image/jpeg", "image/png", "image/webp"];
const VIDEO_MIME_PREFIXES = ["video/mp4", "video/3gpp"];

function resolveMediaType(mimeType: string): WhatsAppMediaType {
  if (IMAGE_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) return "image";
  if (VIDEO_MIME_PREFIXES.some((p) => mimeType.startsWith(p))) return "video";
  return "document";
}

export async function sendWhatsAppReply(
  config: GatewayConfig,
  to: string,
  text: string,
): Promise<void> {
  const chunks = splitText(text, WHATSAPP_MAX_MESSAGE_LEN);

  for (const chunk of chunks) {
    await sendWhatsAppTextMessage(config, to, chunk);
  }

  log.debug({ to, chunks: chunks.length }, "WhatsApp reply sent");
}

export async function sendWhatsAppAttachments(
  config: GatewayConfig,
  to: string,
  assistantId: string | undefined,
  attachments: RuntimeAttachmentMeta[],
): Promise<void> {
  const failures: string[] = [];

  for (const meta of attachments) {
    if (meta.sizeBytes !== undefined && meta.sizeBytes > config.maxAttachmentBytes) {
      log.warn({ attachmentId: meta.id, sizeBytes: meta.sizeBytes }, "Skipping oversized outbound attachment");
      failures.push(meta.filename ?? meta.id);
      continue;
    }

    try {
      const payload = assistantId
        ? await downloadAttachment(config, assistantId, meta.id)
        : await downloadAttachmentById(config, meta.id);

      const mimeType = meta.mimeType ?? payload.mimeType ?? "application/octet-stream";
      const filename = meta.filename ?? payload.filename ?? meta.id;
      const buffer = Buffer.from(payload.data, "base64");
      const sizeBytes = meta.sizeBytes ?? payload.sizeBytes ?? buffer.length;

      if (sizeBytes > config.maxAttachmentBytes) {
        log.warn({ attachmentId: meta.id, sizeBytes }, "Skipping oversized outbound attachment (detected after download)");
        failures.push(filename);
        continue;
      }

      const blob = new Blob([buffer], { type: mimeType });
      const mediaType = resolveMediaType(mimeType);

      const uploaded = await uploadWhatsAppMedia(config, blob, filename, mimeType);
      await sendWhatsAppMediaMessage(config, to, mediaType, uploaded.id, filename);

      log.debug({ to, attachmentId: meta.id, filename, mediaType }, "Attachment sent to WhatsApp");
    } catch (err) {
      const displayName = meta.filename ?? meta.id;
      log.error({ err, attachmentId: meta.id, filename: displayName }, "Failed to send attachment to WhatsApp");
      failures.push(displayName);
    }
  }

  if (failures.length > 0) {
    const notice = `${failures.length} attachment(s) could not be delivered: ${failures.join(", ")}`;
    try {
      await sendWhatsAppReply(config, to, notice);
    } catch (err) {
      log.error({ err, to }, "Failed to send attachment failure notice");
    }
  }
}
