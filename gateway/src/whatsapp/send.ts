import type { GatewayConfig } from "../config.js";
import type { ApprovalPayload } from "../http/routes/whatsapp-deliver.js";
import { getLogger } from "../logger.js";
import {
  downloadAttachment,
  type RuntimeAttachmentMeta,
} from "../runtime/client.js";
import { splitText } from "../util/split-text.js";
import {
  sendWhatsAppInteractiveMessage,
  sendWhatsAppTextMessage,
  uploadWhatsAppMedia,
  sendWhatsAppMediaMessage,
  type WhatsAppMediaType,
  type WhatsAppApiCaches,
} from "./api.js";

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

/**
 * Select up to WHATSAPP_MAX_BUTTONS actions for WhatsApp interactive buttons.
 * When there are more actions than the cap allows, this ensures that `reject`
 * and `approve_always` are always preserved (they are the most important
 * decisions), with remaining slots filled by other approve variants in order.
 */
function selectWhatsAppButtons(
  actions: Array<{ id: string; label: string }>,
): Array<{ id: string; label: string }> {
  if (actions.length <= WHATSAPP_MAX_BUTTONS) return actions;

  // Always preserve reject and approve_always when present
  const pinned = actions.filter(
    (a) => a.id === "reject" || a.id === "approve_always",
  );
  const rest = actions.filter(
    (a) => a.id !== "reject" && a.id !== "approve_always",
  );
  const slotsForRest = WHATSAPP_MAX_BUTTONS - pinned.length;
  const selected = [...rest.slice(0, slotsForRest), ...pinned];
  return selected;
}

export async function sendWhatsAppReply(
  config: GatewayConfig,
  to: string,
  text: string,
  approval?: ApprovalPayload,
  caches?: WhatsAppApiCaches,
): Promise<void> {
  if (approval) {
    // WhatsApp interactive buttons: up to 3 buttons, 20-char titles, 1024-char body.
    // When there are more actions than the button cap allows, prioritize keeping
    // the reject action visible alongside the most important approve variants.
    const selectedActions = selectWhatsAppButtons(approval.actions);
    const buttons = selectedActions.map((action) => ({
      id: `apr:${approval.requestId}:${action.id}`,
      title: action.label.slice(0, WHATSAPP_BUTTON_TITLE_MAX_LEN),
    }));

    // If text fits in the interactive body limit, send as single interactive message
    if (text.length <= WHATSAPP_INTERACTIVE_BODY_MAX_LEN) {
      await sendWhatsAppInteractiveMessage(to, text, buttons, caches);
      log.debug({ to }, "WhatsApp interactive approval reply sent");
      return;
    }

    // Text too long for interactive body: send text chunks first, then
    // interactive message with truncated body and buttons at the end
    const chunks = splitText(text, WHATSAPP_MAX_MESSAGE_LEN);
    for (let i = 0; i < chunks.length - 1; i++) {
      await sendWhatsAppTextMessage(to, chunks[i], caches);
    }

    const lastChunk = chunks[chunks.length - 1];
    if (lastChunk.length <= WHATSAPP_INTERACTIVE_BODY_MAX_LEN) {
      await sendWhatsAppInteractiveMessage(to, lastChunk, buttons, caches);
    } else {
      // Last chunk still too long — send it as text, then a short interactive prompt
      await sendWhatsAppTextMessage(to, lastChunk, caches);
      await sendWhatsAppInteractiveMessage(
        to,
        "Choose an action:",
        buttons,
        caches,
      );
    }

    log.debug({ to, chunks: chunks.length }, "WhatsApp approval reply sent");
    return;
  }

  const chunks = splitText(text, WHATSAPP_MAX_MESSAGE_LEN);

  for (const chunk of chunks) {
    await sendWhatsAppTextMessage(to, chunk, caches);
  }

  log.debug({ to, chunks: chunks.length }, "WhatsApp reply sent");
}

export type AttachmentResult = {
  allFailed: boolean;
  failureCount: number;
  totalCount: number;
};

export async function sendWhatsAppAttachments(
  config: GatewayConfig,
  to: string,
  attachments: RuntimeAttachmentMeta[],
  caches?: WhatsAppApiCaches,
): Promise<AttachmentResult> {
  const failures: string[] = [];

  for (const meta of attachments) {
    if (
      meta.sizeBytes !== undefined &&
      meta.sizeBytes >
        (config.maxAttachmentBytes.whatsapp ??
          config.maxAttachmentBytes.default)
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

      const mimeType =
        meta.mimeType ?? payload.mimeType ?? "application/octet-stream";
      const filename = meta.filename ?? payload.filename ?? meta.id;
      const buffer = Buffer.from(payload.data, "base64");
      const sizeBytes = meta.sizeBytes ?? payload.sizeBytes ?? buffer.length;

      if (
        sizeBytes >
        (config.maxAttachmentBytes.whatsapp ??
          config.maxAttachmentBytes.default)
      ) {
        log.warn(
          { attachmentId: meta.id, sizeBytes },
          "Skipping oversized outbound attachment (detected after download)",
        );
        failures.push(filename);
        continue;
      }

      const blob = new Blob([buffer], { type: mimeType });
      const mediaType = resolveMediaType(mimeType);

      const uploaded = await uploadWhatsAppMedia(
        blob,
        filename,
        mimeType,
        caches,
      );
      await sendWhatsAppMediaMessage(
        to,
        mediaType,
        uploaded.id,
        filename,
        undefined,
        caches,
      );

      log.debug(
        { to, attachmentId: meta.id, filename, mediaType },
        "Attachment sent to WhatsApp",
      );
    } catch (err) {
      const displayName = meta.filename ?? meta.id;
      log.error(
        { err, attachmentId: meta.id, filename: displayName },
        "Failed to send attachment to WhatsApp",
      );
      failures.push(displayName);
    }
  }

  if (failures.length > 0) {
    const notice = `${failures.length} attachment(s) could not be delivered: ${failures.join(", ")}`;
    try {
      await sendWhatsAppReply(config, to, notice, undefined, caches);
    } catch (err) {
      log.error({ err, to }, "Failed to send attachment failure notice");
    }
  }

  return {
    allFailed: failures.length === attachments.length,
    failureCount: failures.length,
    totalCount: attachments.length,
  };
}
