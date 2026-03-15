/**
 * HTTP response filtering for the Credential Execution Service.
 *
 * Sanitises raw HTTP responses before returning them to the untrusted
 * assistant runtime. The assistant must never receive:
 * - Raw auth-bearing response headers (e.g. `set-cookie`, `www-authenticate`)
 * - Echoed secret values in response bodies (defense-in-depth scrubbing)
 * - Unbounded response bodies that could exhaust memory
 *
 * The filter also produces a token-free audit summary of every HTTP
 * interaction for the CES audit log.
 */

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * Maximum response body size returned to the assistant (256 KB).
 *
 * Responses larger than this are truncated with a suffix indicating
 * the original size. The full body is never stored — this is a hard
 * clamp, not a soft limit.
 */
const MAX_BODY_BYTES = 256 * 1024;

/**
 * Response headers that are safe to pass through to the assistant.
 *
 * Only these headers are included in the sanitised response.
 * Everything else is stripped — especially `set-cookie`,
 * `www-authenticate`, and any custom auth headers.
 */
const ALLOWED_RESPONSE_HEADERS = new Set([
  "content-type",
  "content-length",
  "content-encoding",
  "content-language",
  "content-disposition",
  "cache-control",
  "etag",
  "last-modified",
  "date",
  "x-request-id",
  "x-ratelimit-limit",
  "x-ratelimit-remaining",
  "x-ratelimit-reset",
  "retry-after",
  "link",
  "location",
  "vary",
  "accept-ranges",
  "access-control-allow-origin",
  "access-control-allow-methods",
  "access-control-allow-headers",
  "access-control-expose-headers",
]);

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Raw HTTP response from the outbound call. */
export interface RawHttpResponse {
  /** HTTP status code. */
  statusCode: number;
  /** Raw response headers (key-value pairs, header names may be mixed case). */
  headers: Record<string, string>;
  /** Response body as a string. */
  body: string;
}

/** Sanitised HTTP response safe for the assistant runtime. */
export interface SanitisedHttpResponse {
  /** HTTP status code (passed through). */
  statusCode: number;
  /** Whitelisted response headers (lowercased keys). */
  headers: Record<string, string>;
  /** Body clamped to MAX_BODY_BYTES with secrets scrubbed. */
  body: string;
  /** Whether the body was truncated. */
  truncated: boolean;
  /** Original body size in bytes (before truncation). */
  originalBodyBytes: number;
}

// ---------------------------------------------------------------------------
// Header filtering
// ---------------------------------------------------------------------------

/**
 * Filter response headers to only include whitelisted safe headers.
 *
 * All header names are lowercased for consistent comparison.
 */
export function filterResponseHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const filtered: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (ALLOWED_RESPONSE_HEADERS.has(key.toLowerCase())) {
      filtered[key.toLowerCase()] = value;
    }
  }
  return filtered;
}

// ---------------------------------------------------------------------------
// Body clamping
// ---------------------------------------------------------------------------

/**
 * Clamp the response body to the maximum allowed size.
 *
 * Returns the (possibly truncated) body and metadata about truncation.
 */
export function clampBody(body: string): {
  clampedBody: string;
  truncated: boolean;
  originalBytes: number;
} {
  const bodyBytes = Buffer.byteLength(body, "utf-8");

  if (bodyBytes <= MAX_BODY_BYTES) {
    return {
      clampedBody: body,
      truncated: false,
      originalBytes: bodyBytes,
    };
  }

  // Truncate to MAX_BODY_BYTES. We use Buffer to handle multi-byte characters
  // correctly — slice at byte boundaries and convert back to string.
  const buf = Buffer.from(body, "utf-8");
  const truncatedBuf = buf.subarray(0, MAX_BODY_BYTES);

  // Decode back to string; incomplete multi-byte sequences at the end are
  // replaced with the Unicode replacement character, which is acceptable
  // for a truncated preview.
  const truncatedBody = truncatedBuf.toString("utf-8");

  return {
    clampedBody:
      truncatedBody +
      `\n\n[CES: Response truncated from ${bodyBytes} bytes to ${MAX_BODY_BYTES} bytes]`,
    truncated: true,
    originalBytes: bodyBytes,
  };
}

// ---------------------------------------------------------------------------
// Secret scrubbing (defense-in-depth)
// ---------------------------------------------------------------------------

/**
 * Scrub exact occurrences of known secret values from a response body.
 *
 * This is a defense-in-depth measure for APIs that echo back auth tokens
 * or API keys in their response bodies. The scrubbing replaces exact
 * matches of the secret with a redacted placeholder.
 *
 * Limitations:
 * - Only scrubs exact matches (no partial or encoded variants).
 * - Short secrets (< 8 characters) are skipped to avoid false positives.
 * - This is NOT a primary security control — the grant system and
 *   credential isolation are the real boundaries.
 */
export function scrubSecrets(body: string, secrets: string[]): string {
  let result = body;
  for (const secret of secrets) {
    // Skip short secrets to avoid false positives with common substrings
    if (secret.length < 8) continue;
    // Use a simple global replace — secrets are treated as literal strings
    result = replaceAll(result, secret, "[CES:REDACTED]");
  }
  return result;
}

/**
 * Replace all occurrences of `search` in `str` with `replacement`.
 *
 * Uses a simple loop to avoid regex special-character escaping issues
 * with secret values that may contain regex metacharacters.
 */
function replaceAll(str: string, search: string, replacement: string): string {
  if (search.length === 0) return str;

  let result = "";
  let idx = 0;
  while (idx < str.length) {
    const foundAt = str.indexOf(search, idx);
    if (foundAt === -1) {
      result += str.slice(idx);
      break;
    }
    result += str.slice(idx, foundAt) + replacement;
    idx = foundAt + search.length;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Full response filter
// ---------------------------------------------------------------------------

/**
 * Apply the full sanitisation pipeline to a raw HTTP response.
 *
 * Pipeline:
 * 1. Filter response headers to the whitelist.
 * 2. Clamp the body to MAX_BODY_BYTES.
 * 3. Scrub known secrets from the (already clamped) body.
 *
 * @param raw - The raw HTTP response from the outbound call.
 * @param secrets - Known secret values to scrub from the body.
 * @returns Sanitised response safe for the assistant runtime.
 */
export function filterHttpResponse(
  raw: RawHttpResponse,
  secrets: string[] = [],
): SanitisedHttpResponse {
  const filteredHeaders = filterResponseHeaders(raw.headers);
  const { clampedBody, truncated, originalBytes } = clampBody(raw.body);
  const scrubbedBody = scrubSecrets(clampedBody, secrets);

  return {
    statusCode: raw.statusCode,
    headers: filteredHeaders,
    body: scrubbedBody,
    truncated,
    originalBodyBytes: originalBytes,
  };
}
