import { fileTypeFromBuffer } from "file-type";
import type { GatewayConfig } from "../config.js";
import { getWhatsAppMediaMetadata, downloadWhatsAppMediaBytes } from "./api.js";

export interface DownloadedFile {
  filename: string;
  mimeType: string;
  data: string; // base64-encoded
}

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
  const ext = MIME_EXTENSIONS[mimeType];
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
): Promise<DownloadedFile> {
  const meta = await getWhatsAppMediaMetadata(config, mediaId);

  const response = await downloadWhatsAppMediaBytes(config, meta.url);
  const buffer = await response.arrayBuffer();

  const detected = await fileTypeFromBuffer(new Uint8Array(buffer));

  // Prefer the MIME type from Meta metadata, then detected, then Content-Type header
  const mimeType =
    meta.mime_type ||
    detected?.mime ||
    response.headers.get("Content-Type")?.split(";")[0].trim() ||
    "application/octet-stream";

  const filename = inferFilename(mediaId, mimeType);
  const data = Buffer.from(buffer).toString("base64");

  return { filename, mimeType, data };
}
