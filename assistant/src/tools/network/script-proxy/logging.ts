/**
 * Sanitization utilities for proxy log entries.
 *
 * All proxy logging must pass through these helpers so that secrets
 * injected via credential templates (Authorization headers, API key
 * query params, etc.) are never persisted or printed in plaintext.
 */

const REDACTED = '[REDACTED]';

/**
 * Replace values of sensitive header keys with a redaction placeholder.
 *
 * Matching is case-insensitive — "Authorization" and "authorization"
 * are both caught. The caller supplies the set of sensitive key names
 * (lowercased) because different credential templates inject into
 * different headers.
 */
export function sanitizeHeaders(
  headers: Record<string, string>,
  sensitiveKeys: string[],
): Record<string, string> {
  const lower = new Set(sensitiveKeys.map((k) => k.toLowerCase()));
  const out: Record<string, string> = {};

  for (const [key, value] of Object.entries(headers)) {
    out[key] = lower.has(key.toLowerCase()) ? REDACTED : value;
  }

  return out;
}

/**
 * Redact query-parameter values for sensitive param names.
 *
 * Returns a URL string where the values of `sensitiveParams` are
 * replaced with the redaction placeholder. Non-sensitive params and
 * the rest of the URL are preserved verbatim.
 */
export function sanitizeUrl(
  url: string,
  sensitiveParams: string[],
): string {
  if (sensitiveParams.length === 0) return url;

  // Guard against malformed input — return the URL unchanged if it
  // doesn't contain a query string at all.
  const qIdx = url.indexOf('?');
  if (qIdx === -1) return url;

  try {
    // Build a full URL if given an absolute path, otherwise parse as-is
    const parseable = url.startsWith('/') ? `http://placeholder${url}` : url;
    const parsed = new URL(parseable);
    const lower = new Set(sensitiveParams.map((p) => p.toLowerCase()));

    for (const key of Array.from(parsed.searchParams.keys())) {
      if (lower.has(key.toLowerCase())) {
        parsed.searchParams.set(key, REDACTED);
      }
    }

    // Reconstruct the original shape: if the input was a path we strip
    // the placeholder origin so the caller gets back a relative path.
    if (url.startsWith('/')) {
      return parsed.pathname + parsed.search;
    }
    return parsed.toString();
  } catch {
    // Fail closed: if we can't parse the URL, strip the query string
    // entirely rather than risk leaking secrets in log output.
    return url.slice(0, qIdx);
  }
}

/**
 * Build a log-safe snapshot of an outbound proxy request.
 *
 * `sensitiveKeys` should include header names and query param names
 * that carry credential values (e.g. "Authorization", "api_key").
 */
export function createSafeLogEntry(
  req: { method: string; url: string; headers: Record<string, string> },
  sensitiveKeys: string[],
): { method: string; url: string; headers: Record<string, string> } {
  return {
    method: req.method,
    url: sanitizeUrl(req.url, sensitiveKeys),
    headers: sanitizeHeaders(req.headers, sensitiveKeys),
  };
}
