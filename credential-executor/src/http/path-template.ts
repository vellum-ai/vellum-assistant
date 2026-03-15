/**
 * Deterministic path-template derivation for HTTP grant proposals.
 *
 * Normalises URLs and replaces only well-known dynamic segments (numeric IDs,
 * UUIDs, and long hex strings) with typed placeholders while keeping every
 * other path segment literal. This ensures that proposals are specific enough
 * to be meaningful ("allow GET on /repos/{owner}/pulls/{:num}") without
 * over-expanding to wildcard patterns that would be too permissive.
 *
 * Design invariants:
 * - Query strings and fragments are stripped — only scheme + host + path matter.
 * - Host is preserved literally (no wildcard expansion).
 * - Path never collapses to `/*`.
 * - Trailing slashes are normalised away.
 */

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Safely decode a percent-encoded path segment. Falls back to the raw
 * segment when it contains malformed escapes (e.g. bare `%` or `%zz`)
 * that would cause `decodeURIComponent` to throw a `URIError`.
 */
function safeDecodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

// ---------------------------------------------------------------------------
// Segment classification patterns
// ---------------------------------------------------------------------------

/**
 * UUID v4 pattern (case-insensitive): 8-4-4-4-12 hex digits with hyphens.
 */
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Purely numeric segments (e.g. resource IDs like `/users/42`).
 */
const NUMERIC_RE = /^[0-9]+$/;

/**
 * Hex-like strings of 16+ characters — commonly used for opaque identifiers,
 * commit SHAs, object IDs, etc. Must be at least 16 chars to avoid matching
 * short, human-meaningful slugs that happen to be hex-only (e.g. "cafe",
 * "dead", "beef").
 */
const HEX_LONG_RE = /^[0-9a-f]{16,}$/i;

// ---------------------------------------------------------------------------
// Placeholder types
// ---------------------------------------------------------------------------

/**
 * Replace a path segment with a typed placeholder if it matches a known
 * dynamic pattern. Returns the original segment if it does not match.
 */
function classifySegment(segment: string): string {
  if (UUID_RE.test(segment)) return "{:uuid}";
  if (NUMERIC_RE.test(segment)) return "{:num}";
  if (HEX_LONG_RE.test(segment)) return "{:hex}";
  return segment;
}

// ---------------------------------------------------------------------------
// Path template derivation
// ---------------------------------------------------------------------------

/**
 * Derive a deterministic path template from a raw URL.
 *
 * 1. Parse the URL to extract scheme, host, and pathname.
 * 2. Strip query string and fragment.
 * 3. Split the pathname into segments and classify each one.
 * 4. Reassemble into `scheme://host/path/with/{placeholders}`.
 *
 * Throws if `rawUrl` is not a valid absolute URL.
 */
export function derivePathTemplate(rawUrl: string): string {
  const parsed = new URL(rawUrl);

  // Normalise: strip query and fragment, lowercase the host
  const scheme = parsed.protocol.replace(/:$/, "");
  const host = parsed.hostname + (parsed.port ? `:${parsed.port}` : "");

  // Split path into segments, dropping empty segments from leading/trailing slashes
  const segments = parsed.pathname
    .split("/")
    .filter((s) => s.length > 0);

  const templatedSegments = segments.map(classifySegment);

  const path =
    templatedSegments.length > 0
      ? "/" + templatedSegments.join("/")
      : "/";

  return `${scheme}://${host}${path}`;
}

/**
 * Derive the allowed URL pattern for an HTTP grant proposal.
 *
 * Returns an array with a single pattern string — the path template.
 * The caller uses this to populate `allowedUrlPatterns` on the proposal.
 *
 * This is a thin wrapper around `derivePathTemplate` that returns an array
 * for direct use in proposal construction.
 */
export function deriveAllowedUrlPatterns(rawUrl: string): string[] {
  return [derivePathTemplate(rawUrl)];
}

/**
 * Check whether a concrete URL matches a path template pattern.
 *
 * Used during grant evaluation to determine whether a stored
 * `allowedUrlPatterns` entry covers a requested URL.
 *
 * Matching rules:
 * - Scheme and host must match exactly (case-insensitive).
 * - Path segments must match positionally.
 * - A `{:num}` placeholder matches any purely numeric segment.
 * - A `{:uuid}` placeholder matches any UUID v4 segment.
 * - A `{:hex}` placeholder matches any 16+-char hex segment.
 * - Literal segments must match exactly (case-sensitive — URL paths are
 *   case-sensitive per RFC 3986).
 */
export function urlMatchesTemplate(
  rawUrl: string,
  template: string,
): boolean {
  let parsedUrl: URL;
  let parsedTemplate: URL;

  try {
    parsedUrl = new URL(rawUrl);
  } catch {
    return false;
  }
  try {
    parsedTemplate = new URL(template);
  } catch {
    return false;
  }

  // Scheme must match
  if (parsedUrl.protocol !== parsedTemplate.protocol) return false;

  // Host must match (case-insensitive)
  const urlHost =
    parsedUrl.hostname.toLowerCase() +
    (parsedUrl.port ? `:${parsedUrl.port}` : "");
  const templateHost =
    parsedTemplate.hostname.toLowerCase() +
    (parsedTemplate.port ? `:${parsedTemplate.port}` : "");
  if (urlHost !== templateHost) return false;

  // Split paths and compare segment-by-segment.
  // safeDecodeSegment is applied to both sides so that percent-encoded bytes
  // (e.g. %20, %7B) are compared consistently and so that the URL constructor's
  // encoding of curly braces ({, }) in template placeholders is reversed.
  const urlSegments = parsedUrl.pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map(safeDecodeSegment);
  const templateSegments = parsedTemplate.pathname
    .split("/")
    .filter((s) => s.length > 0)
    .map(safeDecodeSegment);

  if (urlSegments.length !== templateSegments.length) return false;

  for (let i = 0; i < templateSegments.length; i++) {
    const tSeg = templateSegments[i];
    const uSeg = urlSegments[i];

    if (tSeg === "{:num}") {
      if (!NUMERIC_RE.test(uSeg)) return false;
    } else if (tSeg === "{:uuid}") {
      if (!UUID_RE.test(uSeg)) return false;
    } else if (tSeg === "{:hex}") {
      if (!HEX_LONG_RE.test(uSeg)) return false;
    } else {
      // Literal match (case-sensitive)
      if (tSeg !== uSeg) return false;
    }
  }

  return true;
}
