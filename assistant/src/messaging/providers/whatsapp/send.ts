/**
 * WhatsApp outbound message orchestration.
 *
 * Handles text splitting, approval button rendering, and attachment delivery
 * by calling the Meta Cloud API directly via ./api.ts.
 */

import type { ApprovalUIMetadata } from "@vellumai/gateway-client";

import * as attachmentsStore from "../../../memory/attachments-store.js";
import type { RuntimeAttachmentMetadata } from "../../../runtime/http-types.js";
import { getLogger } from "../../../util/logger.js";
import {
  sendWhatsAppInteractiveMessage,
  sendWhatsAppMediaMessage,
  sendWhatsAppTextMessage,
  uploadWhatsAppMedia,
  type WhatsAppMediaType,
} from "./api.js";

const log = getLogger("whatsapp-send");

// WhatsApp supports up to 4096 characters per text message
const WHATSAPP_MAX_MESSAGE_LEN = 4096;

// WhatsApp interactive message body text limit is 1024 characters
const WHATSAPP_INTERACTIVE_BODY_MAX_LEN = 1024;

// WhatsApp reply button title limit is 20 characters
const WHATSAPP_BUTTON_TITLE_MAX_LEN = 20;

// WhatsApp supports a maximum of 3 reply buttons
const WHATSAPP_MAX_BUTTONS = 3;

const WHATSAPP_IMAGE_MIME_PREFIXES = ["image/jpeg", "image/png", "image/webp"];
const WHATSAPP_VIDEO_MIME_PREFIXES = ["video/mp4", "video/3gpp"];
const WHATSAPP_MAX_ATTACHMENT_BYTES = 25 * 1024 * 1024;

function resolveMediaType(mimeType: string): WhatsAppMediaType {
  if (WHATSAPP_IMAGE_MIME_PREFIXES.some((p) => mimeType.startsWith(p)))
    return "image";
  if (WHATSAPP_VIDEO_MIME_PREFIXES.some((p) => mimeType.startsWith(p)))
    return "video";
  return "document";
}

/**
 * Split text into chunks that respect WhatsApp's character limit.
 * Tries to split on newlines first, then whitespace, then hard-cuts.
 */
function splitText(text: string, maxLen: number): string[] {
  if (text.length <= maxLen) return [text];

  const chunks: string[] = [];
  let remaining = text;

  while (remaining.length > maxLen) {
    let splitIdx = remaining.lastIndexOf("\n", maxLen);
    if (splitIdx <= 0) splitIdx = remaining.lastIndexOf(" ", maxLen);
    if (splitIdx <= 0) splitIdx = maxLen;

    chunks.push(remaining.slice(0, splitIdx));
    remaining = remaining.slice(splitIdx).trimStart();
  }

  if (remaining.length > 0) chunks.push(remaining);
  return chunks;
}

/**
 * Select up to WHATSAPP_MAX_BUTTONS actions for WhatsApp interactive buttons.
 * Preserves reject and approve_always when there are too many actions.
 */
function selectButtons(
  actions: Array<{ id: string; label: string }>,
): Array<{ id: string; label: string }> {
  if (actions.length <= WHATSAPP_MAX_BUTTONS) return actions;

  const pinned = actions.filter(
    (a) => a.id === "reject" || a.id === "approve_always",
  );
  const rest = actions.filter(
    (a) => a.id !== "reject" && a.id !== "approve_always",
  );
  const slotsForRest = WHATSAPP_MAX_BUTTONS - pinned.length;
  return [...rest.slice(0, slotsForRest), ...pinned];
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function sendWhatsAppReply(
  to: string,
  text: string,
  approval?: ApprovalUIMetadata,
): Promise<void> {
  if (approval) {
    const selectedActions = selectButtons(approval.actions);
    const buttons = selectedActions.map((action) => ({
      id: `apr:${approval.requestId}:${action.id}`,
      title: action.label.slice(0, WHATSAPP_BUTTON_TITLE_MAX_LEN),
    }));

    if (text.length <= WHATSAPP_INTERACTIVE_BODY_MAX_LEN) {
      await sendWhatsAppInteractiveMessage(to, text, buttons);
      log.debug({ to }, "WhatsApp interactive approval reply sent");
      return;
    }

    const chunks = splitText(text, WHATSAPP_MAX_MESSAGE_LEN);
    for (let i = 0; i < chunks.length - 1; i++) {
      await sendWhatsAppTextMessage(to, chunks[i]);
    }

    const lastChunk = chunks[chunks.length - 1];
    if (lastChunk.length <= WHATSAPP_INTERACTIVE_BODY_MAX_LEN) {
      await sendWhatsAppInteractiveMessage(to, lastChunk, buttons);
    } else {
      await sendWhatsAppTextMessage(to, lastChunk);
      await sendWhatsAppInteractiveMessage(to, "Choose an action:", buttons);
    }

    log.debug({ to, chunks: chunks.length }, "WhatsApp approval reply sent");
    return;
  }

  const chunks = splitText(text, WHATSAPP_MAX_MESSAGE_LEN);
  for (const chunk of chunks) {
    await sendWhatsAppTextMessage(to, chunk);
  }
  log.debug({ to, chunks: chunks.length }, "WhatsApp reply sent");
}

export type AttachmentResult = {
  allFailed: boolean;
  failureCount: number;
  totalCount: number;
};

export async function sendWhatsAppAttachments(
  to: string,
  attachments: RuntimeAttachmentMetadata[],
): Promise<AttachmentResult> {
  const failures: string[] = [];

  for (const meta of attachments) {
    if (
      meta.sizeBytes !== undefined &&
      meta.sizeBytes > WHATSAPP_MAX_ATTACHMENT_BYTES
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

      if (content.length > WHATSAPP_MAX_ATTACHMENT_BYTES) {
        log.warn(
          { attachmentId: meta.id, sizeBytes: content.length },
          "Skipping oversized outbound attachment (detected after read)",
        );
        failures.push(filename);
        continue;
      }

      const blob = new Blob([new Uint8Array(content)], { type: mimeType });
      const mediaType = resolveMediaType(mimeType);

      const uploaded = await uploadWhatsAppMedia(blob, filename, mimeType);
      await sendWhatsAppMediaMessage(to, mediaType, uploaded.id, filename);

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
      await sendWhatsAppReply(to, notice);
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
