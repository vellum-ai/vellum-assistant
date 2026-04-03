import { fileTypeFromBuffer } from "file-type";
import { validateDownloadedContent } from "../download-validation.js";
import { fetchImpl } from "../fetch.js";
import type { SlackFile } from "./normalize.js";

export interface DownloadedFile {
  filename: string;
  mimeType: string;
  data: string; // base64-encoded
}

const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Download a Slack file using the bot token for authentication.
 * Prefers url_private_download; falls back to url_private.
 */
export async function downloadSlackFile(
  file: SlackFile,
  botToken: string,
): Promise<DownloadedFile> {
  const url = file.url_private_download || file.url_private;
  if (!url) {
    throw new Error(`Slack file ${file.id} has no download URL`);
  }

  // Use manual redirect handling — Slack may redirect to a CDN subdomain
  // (e.g. files-edge.slack.com) and the Fetch spec strips the Authorization
  // header on cross-origin redirects, causing the CDN request to fail.
  let response = await fetchImpl(url, {
    headers: { Authorization: `Bearer ${botToken}` },
    redirect: "manual",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (!location) {
      throw new Error(
        `Slack file ${file.id} returned ${response.status} redirect with no Location header`,
      );
    }
    // CDN redirect URLs are signed — no Authorization needed.
    // Resolve against the original URL to handle relative Location headers.
    const resolvedLocation = new URL(location, url).href;
    response = await fetchImpl(resolvedLocation, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  }

  if (!response.ok) {
    throw new Error(
      `Failed to download Slack file ${file.id}: ${response.status} ${response.statusText}`,
    );
  }

  const buffer = await response.arrayBuffer();
  const detected = await fileTypeFromBuffer(new Uint8Array(buffer));

  const mimeType =
    file.mimetype ||
    detected?.mime ||
    response.headers.get("Content-Type")?.split(";")[0].trim() ||
    "application/octet-stream";

  await validateDownloadedContent(new Uint8Array(buffer), mimeType, file.id);

  const filename = file.name || `slack_file_${file.id}`;
  const data = Buffer.from(buffer).toString("base64");

  return { filename, mimeType, data };
}
