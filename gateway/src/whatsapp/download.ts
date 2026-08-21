import {
  finalizeDownloadedAttachment,
  readLimitedAttachmentResponse,
} from "../attachments/download.js";
import { AttachmentTooLargeError } from "../attachments/ingest.js";
import type { DownloadedAttachment } from "../attachments/ingest.js";
import type { GatewayConfig } from "../config.js";
import {
  getWhatsAppMediaMetadata,
  downloadWhatsAppMediaBytes,
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
  maxBytes: number,
  hint?: { fileName?: string; mimeType?: string },
  caches?: WhatsAppApiCaches,
): Promise<DownloadedAttachment> {
  const meta = await getWhatsAppMediaMetadata(mediaId, caches);

  if (meta.file_size > maxBytes) {
    throw new AttachmentTooLargeError(
      `WhatsApp media ${mediaId} exceeds size limit (${meta.file_size} > ${maxBytes} bytes)`,
    );
  }

  const response = await downloadWhatsAppMediaBytes(meta.url, caches);
  // Meta metadata is authoritative; detected bytes are trusted; the caller
  // hint is untrusted and follows byte detection.
  return finalizeDownloadedAttachment(
    await readLimitedAttachmentResponse(response, maxBytes, mediaId),
    {
      attachmentId: mediaId,
      mimeTypeCandidatesBeforeDetection: [meta.mime_type],
      mimeTypeCandidatesAfterDetection: [hint?.mimeType],
      responseContentType: response.headers.get("Content-Type"),
      filename: hint?.fileName,
      fallbackFilename: (mimeType) => inferFilename(mediaId, mimeType),
    },
  );
}
