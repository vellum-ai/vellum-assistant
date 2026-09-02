/**
 * Shared helpers for deciding how an outbound OAuth request body is encoded.
 *
 * A body is structured (an object or array, serialized as JSON), raw text
 * (a string forwarded to the provider as UTF-8), or raw bytes (a Buffer
 * forwarded to the provider byte-for-byte). The Content-Type the caller
 * supplied decides which one a string body is: multipart, XML, form-encoded,
 * and CSV payloads must survive intact, while JSON text is already in its
 * wire form and must not be re-encoded. Files that are not valid UTF-8, or
 * that carry a binary Content-Type, stay as bytes.
 */

const BINARY_MEDIA_TYPES = new Set([
  "application/octet-stream",
  "application/pdf",
  "application/zip",
  "application/gzip",
  "application/x-gzip",
]);

/** True when a Content-Type header names a JSON media type. */
export function isJsonContentType(
  contentType: string | undefined | null,
): boolean {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  return mediaType === "application/json" || mediaType.endsWith("+json");
}

/** Case-insensitive Content-Type lookup over a plain header map. */
export function findContentTypeHeader(
  headers: Record<string, string> | undefined,
): string | undefined {
  if (!headers) {
    return undefined;
  }
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() === "content-type") {
      return value;
    }
  }
  return undefined;
}

/**
 * Decide how a `-d` payload reaches the provider.
 *
 * With a non-JSON Content-Type the raw string is kept verbatim. Otherwise the
 * string is JSON-parsed so structured bodies keep flowing through the pipeline
 * as objects; text that does not parse stays a string.
 */
export function parseRequestBodyData(
  raw: string,
  contentType: string | undefined,
): unknown {
  if (contentType !== undefined && !isJsonContentType(contentType)) {
    return raw;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return raw;
  }
  // A JSON string scalar ("hello") would be indistinguishable from a raw
  // body once unquoted, so the original quoted text is kept as the wire form.
  return typeof parsed === "string" ? raw : parsed;
}

/** True when a Content-Type names a binary media type (PDF, image, zip). */
export function isBinaryOAuthContentType(
  contentType: string | undefined | null,
): boolean {
  if (!contentType) {
    return false;
  }
  const mediaType = contentType.split(";")[0]?.trim().toLowerCase() ?? "";
  if (
    mediaType.startsWith("image/") ||
    mediaType.startsWith("audio/") ||
    mediaType.startsWith("video/")
  ) {
    return true;
  }
  return BINARY_MEDIA_TYPES.has(mediaType);
}

/**
 * Decide how file or stdin bytes reach the provider.
 *
 * Binary Content-Types and payloads that are not valid UTF-8 stay as a
 * Buffer so the original bytes survive the JSON proxy envelope. Valid UTF-8
 * follows {@link parseRequestBodyData}.
 */
export function parseRequestBodyBytes(
  raw: Uint8Array,
  contentType: string | undefined,
): unknown {
  if (isBinaryOAuthContentType(contentType)) {
    return Buffer.from(raw);
  }
  let utf8: string;
  try {
    utf8 = new TextDecoder("utf-8", { fatal: true }).decode(raw);
  } catch {
    return Buffer.from(raw);
  }
  return parseRequestBodyData(utf8, contentType);
}
