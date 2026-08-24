/**
 * Shared helpers for deciding how an outbound OAuth request body is encoded.
 *
 * A body is either structured (an object or array, serialized as JSON) or
 * raw (a string forwarded to the provider byte-for-byte). The Content-Type
 * the caller supplied decides which one a string body is: multipart, XML,
 * form-encoded, and CSV payloads must survive intact, while JSON text is
 * already in its wire form and must not be re-encoded.
 */

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
