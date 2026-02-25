import type { GatewayConfig } from "../config.js";
import type { ApprovalPayload } from "../http/routes/whatsapp-deliver.js";
import { getLogger } from "../logger.js";
import { downloadAttachment, downloadAttachmentById, type RuntimeAttachmentMeta } from "../runtime/client.js";
import { splitText } from "../util/split-text.js";
import { sendWhatsAppInteractiveMessage, sendWhatsAppTextMessage, uploadWhatsAppMedia, sendWhatsAppMediaMessage, type WhatsAppMediaType } from "./api.js";

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

// WhatsApp interactive message body text limit is 1024 characters
const WHATSAPP_INTERACTIVE_BODY_MAX_LEN = 1024;

// WhatsApp reply button title limit is 20 characters
const WHATSAPP_BUTTON_TITLE_MAX_LEN = 20;

// WhatsApp supports a maximum of 3 reply buttons
const WHATSAPP_MAX_BUTTONS = 3;

export async function sendWhatsAppReply(
  config: GatewayConfig,
  to: string,
  text: string,
  approval?: ApprovalPayload,
): Promise<void> {
  if (approval) {
    // WhatsApp interactive buttons: up to 3 buttons, 20-char titles, 1024-char body
    const buttons = approval.actions.slice(0, WHATSAPP_MAX_BUTTONS).map((action) => ({
      id: `apr:${approval.runId}:${action.id}`,
      title: action.label.slice(0, WHATSAPP_BUTTON_TITLE_MAX_LEN),
    }));

    // If text fits in the interactive body limit, send as single interactive message
    if (text.length <= WHATSAPP_INTERACTIVE_BODY_MAX_LEN) {
      await sendWhatsAppInteractiveMessage(config, to, text, buttons);
      log.debug({ to }, "WhatsApp interactive approval reply sent");
      return;
    }

    // Text too long for interactive body: send text chunks first, then
    // interactive message with truncated body and buttons at the end
    const chunks = splitText(text, WHATSAPP_MAX_MESSAGE_LEN);
    for (let i = 0; i < chunks.length - 1; i++) {
      await sendWhatsAppTextMessage(config, to, chunks[i]);
    }

    const lastChunk = chunks[chunks.length - 1];
    if (lastChunk.length <= WHATSAPP_INTERACTIVE_BODY_MAX_LEN) {
      await sendWhatsAppInteractiveMessage(config, to, lastChunk, buttons);
    } else {
      // Last chunk still too long — send it as text, then a short interactive prompt
      await sendWhatsAppTextMessage(config, to, lastChunk);
      await sendWhatsAppInteractiveMessage(config, to, "Choose an action:", buttons);
    }

    log.debug({ to, chunks: chunks.length }, "WhatsApp approval reply sent");
    return;
  }

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

    if (failures.length === attachments.length) {
      throw new Error(`All ${failures.length} attachment(s) failed to deliver`);
    }
  }
}
