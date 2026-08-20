/**
 * Downloads Discord CDN attachments from their signed payload URLs.
 *
 * Discord URLs carry their own `ex`, `is`, and `hm` signatures, so requests
 * use the payload URL verbatim without the bot token or an Authorization
 * header.
 */
import { finalizeDownloadedAttachment } from "../attachments/download.js";
import type { DownloadedAttachment } from "../attachments/ingest.js";
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

  return finalizeDownloadedAttachment(await response.arrayBuffer(), {
    attachmentId: attachment.id,
    mimeTypeCandidates: [attachment.content_type],
    responseContentType: response.headers.get("Content-Type"),
    filename: attachment.filename,
    fallbackFilename: `discord_file_${attachment.id}`,
  });
}
