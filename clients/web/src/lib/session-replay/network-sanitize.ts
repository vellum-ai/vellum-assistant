/**
 * Scrub sensitive data from session-replay network records before they are
 * recorded. Built for the replay provider's `network` config: a request/response
 * sanitizer receives the record and returns a scrubbed copy (or `null` to drop
 * it entirely — unused here; we scrub in place rather than drop).
 *
 * Three surfaces are scrubbed:
 *  - headers      — auth/cookie headers redacted by name
 *  - url/referrer — tokens stripped from query + fragment (reuses `sanitizeUrl`)
 *  - body         — known sensitive keys redacted recursively in structured bodies
 */
import { sanitizeUrl } from "@/lib/sentry/url-sanitize";

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

// Body keys (lowercased) redacted wherever they appear in a structured body.
const SENSITIVE_BODY_KEYS = new Set([
  "access_token",
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
  "code",
  "id_token",
  "password",
  "private_key",
  "pwd",
  "refresh_token",
  "secret",
  "session",
  "token",
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

/**
 * Recursively redact sensitive keys in a structured body. Strings are parsed as
 * JSON when possible (a stringified payload may carry credentials) and otherwise
 * left untouched. Returns the original reference when nothing changed.
 */
function scrubBody(body: unknown): unknown {
  if (typeof body === "string") {
    try {
      const parsed: unknown = JSON.parse(body);
      const scrubbed = scrubBody(parsed);
      return scrubbed === parsed ? body : JSON.stringify(scrubbed);
    } catch {
      return body;
    }
  }
  if (Array.isArray(body)) {
    let changed = false;
    const out = body.map((value) => {
      const scrubbed = scrubBody(value);
      if (scrubbed !== value) changed = true;
      return scrubbed;
    });
    return changed ? out : body;
  }
  if (body && typeof body === "object") {
    let changed = false;
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(body)) {
      if (SENSITIVE_BODY_KEYS.has(key.toLowerCase())) {
        out[key] = REDACTED;
        changed = true;
      } else {
        const scrubbed = scrubBody(value);
        if (scrubbed !== value) changed = true;
        out[key] = scrubbed;
      }
    }
    return changed ? out : body;
  }
  return body;
}

export function sanitizeReplayRequest(
  request: SessionReplayNetworkRequest,
): SessionReplayNetworkRequest {
  return {
    ...request,
    url: request.url ? sanitizeUrl(request.url) : request.url,
    referrer: request.referrer ? sanitizeUrl(request.referrer) : request.referrer,
    headers: scrubHeaders(request.headers),
    body: scrubBody(request.body),
  };
}

export function sanitizeReplayResponse(
  response: SessionReplayNetworkResponse,
): SessionReplayNetworkResponse {
  return {
    ...response,
    url: response.url ? sanitizeUrl(response.url) : response.url,
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
