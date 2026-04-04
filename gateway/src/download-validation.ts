import { fileTypeFromBuffer } from "file-type";

export class ContentMismatchError extends Error {
  override name = "ContentMismatchError";
}

/**
 * Check whether a buffer looks like an HTML page by inspecting the first
 * non-whitespace / non-BOM bytes for common HTML markers.
 */
export function looksLikeHtml(buffer: Uint8Array): boolean {
  // Skip leading whitespace and UTF-8 BOM (0xEF 0xBB 0xBF)
  let offset = 0;
  // Skip UTF-8 BOM if present
  if (
    buffer.length >= 3 &&
    buffer[0] === 0xef &&
    buffer[1] === 0xbb &&
    buffer[2] === 0xbf
  ) {
    offset = 3;
  }
  // Skip whitespace characters (space, tab, newline, carriage return)
  while (offset < buffer.length) {
    const byte = buffer[offset];
    if (byte === 0x20 || byte === 0x09 || byte === 0x0a || byte === 0x0d) {
      offset++;
    } else {
      break;
    }
  }

  if (offset >= buffer.length) {
    return false;
  }

  const remaining = buffer.subarray(offset);
  const prefix = new TextDecoder("utf-8", { fatal: false }).decode(
    remaining.subarray(0, Math.min(remaining.length, 15)),
  );

  const upper = prefix.toUpperCase();
  return upper.startsWith("<!DOCTYPE") || upper.startsWith("<HTML");
}

const BINARY_MIME_PREFIXES = [
  "image/",
  "audio/",
  "video/",
  "application/pdf",
] as const;

/**
 * Validate that downloaded content actually matches its declared MIME type.
 *
 * This catches a common failure mode where CDNs (Slack, WhatsApp, Telegram)
 * return an HTML error or auth page instead of the actual binary file.
 * Base64-encoding that HTML and sending it to a provider as e.g. `image/png`
 * causes the provider to reject the request.
 */
export async function validateDownloadedContent(
  buffer: Uint8Array,
  declaredMime: string,
  fileId: string,
): Promise<void> {
  const isBinary = BINARY_MIME_PREFIXES.some((prefix) =>
    declaredMime.startsWith(prefix),
  );

  if (!isBinary) {
    return;
  }

  // Guard: if the buffer looks like HTML, it's almost certainly an error page
  if (looksLikeHtml(buffer)) {
    throw new ContentMismatchError(
      `File ${fileId} declared as ${declaredMime} but content is HTML (likely an auth/error page)`,
    );
  }

  // For image types, do a deeper check with file-type detection
  if (declaredMime.startsWith("image/")) {
    const detected = await fileTypeFromBuffer(buffer);
    if (detected && !detected.mime.startsWith("image/")) {
      throw new ContentMismatchError(
        `File ${fileId} declared as ${declaredMime} but detected as ${detected.mime}`,
      );
    }
    // If detected is undefined and it doesn't look like HTML, allow it
    // through — some image formats may not be in file-type's database.
  }
}
