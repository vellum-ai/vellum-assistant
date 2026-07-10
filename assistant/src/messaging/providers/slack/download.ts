/**
 * Slack file download for the assistant-side backfill path.
 *
 * The gateway runs the live inbound path and downloads files via its own
 * `gateway/src/slack/download.ts`. The assistant cannot import that module
 * (different package, different fetch infra), so the thread-backfill path
 * has its own minimal downloader here.
 *
 * Both implementations target the same Slack contract:
 *  - `url_private_download` (preferred) / `url_private` (fallback) are
 *    Slack-hosted URLs requiring bot-token auth.
 *  - Slack typically redirects to a CDN host (e.g. `files-edge.slack.com`)
 *    where the signed redirect URL is self-authenticating; the WHATWG fetch
 *    spec strips `Authorization` on cross-origin redirects, so we manually
 *    follow the redirect without re-sending the bot token.
 *
 * Both implementations also share the same byte-level guard from
 * `@vellumai/download-validation`: a CDN that returns an HTML auth/error page
 * with a 200 status can never be surfaced as an image attachment.
 */

import { validateDownloadedContent } from "@vellumai/download-validation";

import { getLogger } from "../../../util/logger.js";

const log = getLogger("slack-download");

export interface DownloadedSlackFile {
  filename: string;
  mimeType: string;
  /** Base64-encoded file bytes. */
  data: string;
}

export interface SlackFileDownloadInput {
  id?: string;
  name: string;
  mimetype?: string;
  urlPrivateDownload?: string;
  urlPrivate?: string;
}

const DOWNLOAD_TIMEOUT_MS = 30_000;

/**
 * Download a Slack file using a raw bot token for authentication.
 *
 * The caller is responsible for resolving the token from the slack adapter
 * (`withSlackBotToken`); this module stays decoupled from the auth-resolution
 * dispatch so it remains trivially mockable in tests.
 *
 * Returns `null` when no usable URL is present on the file metadata — callers
 * commonly pass file shapes that have already been sanitized for persistence
 * (`{ id, name, mimetype }`) and have no way to download. This is treated as
 * an expected branch rather than an error.
 *
 * Throws on transport / HTTP errors, and `ContentMismatchError` when the
 * downloaded bytes don't match the declared MIME type (e.g. an HTML auth page
 * served as an image), so the caller can decide whether to log and skip or
 * fail the surrounding operation. The thread-backfill caller logs and proceeds
 * with the text-only message rather than failing the whole backfill.
 */
export async function downloadSlackFile(
  file: SlackFileDownloadInput,
  token: string,
): Promise<DownloadedSlackFile | null> {
  const url = file.urlPrivateDownload ?? file.urlPrivate;
  if (!url) {
    log.debug(
      { fileId: file.id, name: file.name },
      "Slack file has no download URL; skipping",
    );
    return null;
  }

  let response = await fetch(url, {
    headers: { Authorization: `Bearer ${token}` },
    redirect: "manual",
    signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
  });

  if (response.status >= 300 && response.status < 400) {
    const location = response.headers.get("Location");
    if (!location) {
      throw new Error(
        `Slack file ${file.id ?? file.name} returned ${response.status} redirect with no Location header`,
      );
    }
    // CDN redirect URLs are signed; no Authorization needed. Resolve
    // relative locations against the original URL.
    const resolvedLocation = new URL(location, url).href;
    response = await fetch(resolvedLocation, {
      signal: AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS),
    });
  }

  if (!response.ok) {
    throw new Error(
      `Failed to download Slack file ${file.id ?? file.name}: ${response.status} ${response.statusText}`,
    );
  }

  const buffer = await response.arrayBuffer();
  const bytes = new Uint8Array(buffer);
  const mimeType =
    file.mimetype ||
    response.headers.get("Content-Type")?.split(";")[0]?.trim() ||
    "application/octet-stream";

  // Reject an HTML auth/error page masquerading as a binary before it can be
  // base64-encoded and stored as an image attachment. ContentMismatchError
  // propagates for the caller to log-and-skip.
  await validateDownloadedContent(bytes, mimeType, file.id ?? file.name);

  const filename = file.name || `slack_file_${file.id ?? "unknown"}`;
  const data = Buffer.from(buffer).toString("base64");
  return { filename, mimeType, data };
}
