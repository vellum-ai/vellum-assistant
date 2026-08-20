import { finalizeDownloadedAttachment } from "../attachments/download.js";
import type { DownloadedAttachment } from "../attachments/ingest.js";
import type { GatewayConfig } from "../config.js";
import {
  getWhatsAppMediaMetadata,
  downloadWhatsAppMediaBytes,
  WhatsAppNonRetryableError,
  type WhatsAppApiCaches,
} from "./api.js";

/** Common MIME-to-extension map for when Meta omits a filename. */
const MIME_EXTENSIONS: Record<string, string> = {
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
  "image/gif": "gif",
  "video/mp4": "mp4",
  "video/3gpp": "3gp",
  "audio/aac": "aac",
  "audio/mp4": "m4a",
  "audio/mpeg": "mp3",
  "audio/amr": "amr",
  "audio/ogg": "ogg",
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document":
    "docx",
  "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet": "xlsx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation":
    "pptx",
  "application/vnd.ms-excel": "xls",
  "application/msword": "doc",
  "text/plain": "txt",
};

function inferFilename(mediaId: string, mimeType: string): string {
  const baseMime = mimeType.split(";")[0].trim();
  const ext = MIME_EXTENSIONS[baseMime];
  const base = mediaId.slice(0, 12);
  return ext ? `${base}.${ext}` : base;
}

/**
 * Download a WhatsApp media object by its media ID.
 * Resolves metadata from Meta's Graph API, downloads the binary, and returns
 * the same shape used by uploadAttachment() in the runtime.
 */
export async function downloadWhatsAppFile(
  config: GatewayConfig,
  mediaId: string,
  hint?: { fileName?: string; mimeType?: string },
  caches?: WhatsAppApiCaches,
): Promise<DownloadedAttachment> {
  const meta = await getWhatsAppMediaMetadata(mediaId, caches);

  if (
    meta.file_size >
    (config.maxAttachmentBytes.whatsapp ?? config.maxAttachmentBytes.default)
  ) {
    throw new WhatsAppNonRetryableError(
      `WhatsApp media ${mediaId} exceeds size limit (${meta.file_size} > ${config.maxAttachmentBytes.whatsapp ?? config.maxAttachmentBytes.default} bytes)`,
    );
  }

  const response = await downloadWhatsAppMediaBytes(meta.url, caches);
  // Prefer the MIME type from Meta metadata, then detected (trusted), then hint (untrusted), then Content-Type header
  return finalizeDownloadedAttachment(await response.arrayBuffer(), {
    attachmentId: mediaId,
    mimeTypeCandidates: [meta.mime_type, hint?.mimeType],
    responseContentType: response.headers.get("Content-Type"),
    filename: hint?.fileName,
    fallbackFilename: (mimeType) => inferFilename(mediaId, mimeType),
  });
}
