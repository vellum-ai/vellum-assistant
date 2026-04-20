/**
 * Validator for Google Cloud Storage signed URLs.
 *
 * Used by the migrations import path to confirm that a URL the daemon is
 * about to `fetch()` is, in fact, a signed GCS object URL (and not an
 * attacker-chosen host, scheme, or path).
 *
 * This is a pure function — no I/O, no side effects. The caller decides
 * what to do with the validation result.
 *
 * What we check:
 *   - The string parses as a URL.
 *   - The scheme is `https:` (no `http:`, `file:`, `data:`, etc.).
 *   - The hostname is exactly `storage.googleapis.com`.
 *   - The URL carries a signature query param — either `X-Goog-Signature`
 *     (V4 signing) or `Signature` (V2 signing). If neither is present
 *     the URL is not a signed URL and we refuse it.
 *   - The pathname does not contain `..` segments (traversal guard).
 *
 * On success we return the hostname and pathname for logging/telemetry.
 * We deliberately do NOT return the full URL or the query string,
 * because the signature is sensitive and should not end up in logs.
 */

export type GcsUrlValidation =
  | { ok: true; host: string; path: string }
  | { ok: false; reason: string };

const EXPECTED_HOST = "storage.googleapis.com";

export function validateGcsSignedUrl(raw: string): GcsUrlValidation {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    return { ok: false, reason: "invalid_url" };
  }

  if (parsed.protocol !== "https:") {
    return { ok: false, reason: "scheme" };
  }

  if (parsed.hostname !== EXPECTED_HOST) {
    return { ok: false, reason: "host" };
  }

  const hasV4 = parsed.searchParams.has("X-Goog-Signature");
  const hasV2 = parsed.searchParams.has("Signature");
  if (!hasV4 && !hasV2) {
    return { ok: false, reason: "missing_signature" };
  }

  // Defense-in-depth: reject any `..` path segment. The WHATWG URL
  // parser silently normalizes `/bucket/../foo` to `/foo`, which would
  // hide a traversal attempt — so inspect the *raw* input before
  // normalization in addition to the parsed pathname.
  if (hasTraversalSegment(parsed.pathname) || hasTraversalInRawPath(raw)) {
    return { ok: false, reason: "path_traversal" };
  }

  return { ok: true, host: parsed.hostname, path: parsed.pathname };
}

function hasTraversalSegment(pathname: string): boolean {
  for (const segment of pathname.split("/")) {
    if (segment === "..") return true;
  }
  return false;
}

/**
 * Look for `..` path segments in the raw input before URL normalization.
 * We slice off the scheme+authority and stop at the first `?` or `#`,
 * then examine each segment split on both `/` and `\` (the WHATWG URL
 * parser treats `\` as equivalent to `/` for special schemes like
 * `https:`, so a backslash-delimited traversal would be normalized
 * away by `new URL()`).
 *
 * Inside each segment we also handle percent-encoded separators
 * (`%2F` = `/`, `%5C` = `\`): we pre-normalize those before the
 * top-level split, and we also re-split each decoded segment on `/`
 * and `\` to catch cases like `%2e%2e%2fother` where the encoded
 * slash hides a traversal within a single raw segment.
 */
function hasTraversalInRawPath(raw: string): boolean {
  const schemeEnd = raw.indexOf("://");
  if (schemeEnd === -1) return false;
  const afterScheme = raw.slice(schemeEnd + 3);
  const pathStart = afterScheme.search(/[\/\\]/);
  if (pathStart === -1) return false;
  let path = afterScheme.slice(pathStart);
  const queryIdx = path.indexOf("?");
  if (queryIdx !== -1) path = path.slice(0, queryIdx);
  const hashIdx = path.indexOf("#");
  if (hashIdx !== -1) path = path.slice(0, hashIdx);

  // Normalize percent-encoded forms of `/` and `\` so that encoded
  // separators participate in the segment split.
  const normalized = path.replace(/%2[fF]/g, "/").replace(/%5[cC]/g, "\\");

  for (const segment of normalized.split(/[\/\\]/)) {
    if (segment === "..") return true;
    // Percent-decoded forms of ".." — e.g. "%2E%2E", ".%2e", "%2e.".
    // Also re-split on `/` and `\` to catch encoded separators that
    // weren't covered by the top-level normalization (e.g. a decoded
    // segment `../other`).
    let decoded: string;
    try {
      decoded = decodeURIComponent(segment);
    } catch {
      // Ignore malformed percent-encoding; URL parser would handle it.
      continue;
    }
    for (const sub of decoded.split(/[\/\\]/)) {
      if (sub === "..") return true;
    }
  }
  return false;
}
