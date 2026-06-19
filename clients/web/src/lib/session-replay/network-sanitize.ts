/**
 * Scrub sensitive data from session-replay network records before they are
 * recorded. Built for the replay provider's `network` config: a request/response
 * sanitizer receives the record and returns a scrubbed copy (or `null` to drop
 * it entirely — unused here; we scrub in place rather than drop).
 *
 * Scrubbed surfaces:
 *  - headers      — auth/cookie headers redacted by name
 *  - url/referrer — every query-param VALUE redacted (keys kept) plus any
 *                   parametric fragment. Like bodies, query params can carry
 *                   arbitrary user content under generic keys (e.g. `?q=<search>`),
 *                   so all values are redacted rather than only credential ones.
 *  - body         — request/response bodies are redacted wholesale. Payloads can
 *                   carry credentials/PII under arbitrary keys (e.g. POST
 *                   /v1/secrets sends the raw secret under a generic `value`),
 *                   so nothing is recorded until we introduce a real allowlist.
 */

const REDACTED = "[REDACTED]";

// Header names (lowercased) whose values carry credentials.
const SENSITIVE_HEADERS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-xsrf-token",
  "x-session-token",
]);

export interface SessionReplayNetworkRequest {
  url?: string;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  referrer?: string;
  mode?: string;
}

export interface SessionReplayNetworkResponse {
  status?: number;
  method?: string;
  headers?: Record<string, string>;
  body?: unknown;
  url?: string;
}

export interface SessionReplayNetworkConfig {
  requestSanitizer(
    request: SessionReplayNetworkRequest,
  ): SessionReplayNetworkRequest | null;
  responseSanitizer(
    response: SessionReplayNetworkResponse,
  ): SessionReplayNetworkResponse | null;
  isEnabled: boolean;
}

function scrubHeaders(
  headers: Record<string, string> | undefined,
): Record<string, string> | undefined {
  if (!headers) return headers;
  let changed = false;
  const out: Record<string, string> = {};
  for (const [name, value] of Object.entries(headers)) {
    if (SENSITIVE_HEADERS.has(name.toLowerCase())) {
      out[name] = REDACTED;
      changed = true;
    } else {
      out[name] = value;
    }
  }
  return changed ? out : headers;
}

/** Redact a body wholesale when present; leave an absent body untouched. */
function scrubBody(body: unknown): unknown {
  return body == null ? body : REDACTED;
}

/**
 * Redact every query-param value (keys kept) and any parametric fragment from a
 * URL, preserving scheme/host/path. Handles absolute, protocol-relative, and
 * path-relative URLs; returns the input unchanged when it has no query/fragment
 * or cannot be parsed.
 */
function sanitizeReplayUrl(url: string): string {
  if (!url.includes("?") && !url.includes("#")) return url;
  try {
    const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(url);
    const isProtocolRelative = !hasScheme && url.startsWith("//");
    const base = hasScheme ? undefined : "https://placeholder.invalid";
    const parsed = new URL(url, base);
    for (const key of [...parsed.searchParams.keys()]) {
      parsed.searchParams.set(key, REDACTED);
    }
    // A parametric fragment (OAuth implicit flow: #access_token=…) is redacted
    // wholesale rather than parsed.
    if (parsed.hash.includes("=")) parsed.hash = `#${REDACTED}`;
    if (hasScheme) return parsed.toString();
    if (isProtocolRelative) {
      return `//${parsed.host}${parsed.pathname}${parsed.search}${parsed.hash}`;
    }
    return parsed.pathname + parsed.search + parsed.hash;
  } catch {
    return url;
  }
}

export function sanitizeReplayRequest(
  request: SessionReplayNetworkRequest,
): SessionReplayNetworkRequest {
  return {
    ...request,
    url: request.url ? sanitizeReplayUrl(request.url) : request.url,
    referrer: request.referrer
      ? sanitizeReplayUrl(request.referrer)
      : request.referrer,
    headers: scrubHeaders(request.headers),
    body: scrubBody(request.body),
  };
}

export function sanitizeReplayResponse(
  response: SessionReplayNetworkResponse,
): SessionReplayNetworkResponse {
  return {
    ...response,
    url: response.url ? sanitizeReplayUrl(response.url) : response.url,
    headers: scrubHeaders(response.headers),
    body: scrubBody(response.body),
  };
}

/**
 * Ready-to-use network config for the replay provider's init. Wired into
 * `SessionReplayInitOptions` so a real provider forwards it straight to the SDK.
 */
export const sessionReplayNetworkConfig: SessionReplayNetworkConfig = {
  requestSanitizer: sanitizeReplayRequest,
  responseSanitizer: sanitizeReplayResponse,
  isEnabled: true,
};
