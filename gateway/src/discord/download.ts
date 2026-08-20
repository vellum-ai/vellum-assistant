/**
 * Downloads Discord CDN attachments from their signed payload URLs.
 *
 * Discord URLs carry their own `ex`, `is`, and `hm` signatures, so requests
 * use the payload URL verbatim without the bot token or an Authorization
 * header.
 */
import { fileTypeFromBuffer } from "file-type";

import type { DownloadedAttachment } from "../attachments/ingest.js";
import { validateDownloadedContent } from "../download-validation.js";
import { fetchImpl } from "../fetch.js";
import type { DiscordAttachmentReference } from "./attachments.js";

const DOWNLOAD_TIMEOUT_MS = 30_000;

export async function downloadDiscordFile(
  attachment: DiscordAttachmentReference,
): Promise<DownloadedAttachment> {
  const response = await fetchImpl(attachment.url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download Discord file ${attachment.id}: ${response.status} ${response.statusText}`,
    );
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const detected = await fileTypeFromBuffer(bytes);
  const mimeType =
    attachment.content_type ||
    detected?.mime ||
    response.headers.get("Content-Type")?.split(";")[0].trim() ||
    "application/octet-stream";

  await validateDownloadedContent(bytes, mimeType, attachment.id);

  return {
    filename: attachment.filename || `discord_file_${attachment.id}`,
    mimeType,
    data: Buffer.from(buffer).toString("base64"),
  };
}
