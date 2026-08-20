/**
 * Downloads Discord CDN attachments from their signed payload URLs.
 *
 * Discord URLs carry their own `ex`, `is`, and `hm` signatures, so requests
 * use the payload URL verbatim without the bot token or an Authorization
 * header.
 */
import {
  finalizeDownloadedAttachment,
  readLimitedAttachmentResponse,
} from "../attachments/download.js";
import type { Logger } from "pino";
import type { DownloadedAttachment } from "../attachments/ingest.js";
import { fetchImpl } from "../fetch.js";
import type { DiscordAttachmentReference } from "./attachments.js";

const DOWNLOAD_TIMEOUT_MS = 30_000;

export async function downloadDiscordFile(
  attachment: DiscordAttachmentReference,
  maxBytes: number,
  log?: Logger,
): Promise<DownloadedAttachment> {
  const host = new URL(attachment.url).hostname;
  if (host !== "cdn.discordapp.com" && host !== "media.discordapp.net") {
    // The authenticated gateway payload and post-download validation provide
    // the boundary. This warning detects Discord CDN host drift without
    // fail-closing inbound files when documented hosts change.
    log?.warn(
      { host, url: attachment.url },
      "Discord attachment URL uses an undocumented CDN host",
    );
  }

  const response = await fetchImpl(attachment.url, {
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (!response.ok) {
    throw new Error(
      `Failed to download Discord file ${attachment.id}: ${response.status} ${response.statusText}`,
    );
  }

  return finalizeDownloadedAttachment(
    await readLimitedAttachmentResponse(response, maxBytes, attachment.id),
    {
      attachmentId: attachment.id,
      mimeTypeCandidatesBeforeDetection: [attachment.content_type],
      responseContentType: response.headers.get("Content-Type"),
      filename: attachment.filename,
      fallbackFilename: () => `discord_file_${attachment.id}`,
    },
  );
}
