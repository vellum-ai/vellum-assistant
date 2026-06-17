import {
  installLogRocketControlListeners,
  logRocketConsentGranted,
  syncLogRocketClient,
  type LogRocketOptions,
  type LogRocketRequest,
  type LogRocketResponse,
} from "@/lib/logrocket/logrocket-control";
import { sanitizeUrl } from "@/lib/sentry/url-sanitize";

/**
 * Browser-side LogRocket session-replay initialization, gated on the user's
 * "Help improve Vellum" consent toggle AND acceptance of the current
 * privacy-policy version (see `logrocket-control.ts`).
 *
 * Session replay records the screen, console, and network traffic, so the
 * sanitizers below run inside the SDK before anything is uploaded:
 *
 *   - `dom.inputSanitizer` masks the *content* of every `<input>` /
 *     `<textarea>` so typed secrets (passwords, tokens, API keys) are never
 *     captured. `dom.textSanitizer` is intentionally left off so the
 *     conversation UI remains legible — replay's debugging value.
 *   - `browser.urlSanitizer` and the request/response URL fields reuse the
 *     Sentry `sanitizeUrl` helper to strip auth codes, invite tokens, and
 *     OAuth fragment tokens from recorded URLs.
 *   - The network request/response sanitizers redact credential-bearing
 *     headers (`Authorization`, cookies, API-key headers) and scrub bodies
 *     that carry token-shaped JSON fields.
 *   - `shouldCaptureIP` is disabled — IP/GeoIP is unnecessary for product
 *     debugging and broadens the PII surface.
 *
 * Reference: https://docs.logrocket.com/reference/network
 * Reference: https://docs.logrocket.com/reference/dom
 */

const REDACTED = "[REDACTED]";

// Header names whose values are credentials and must never be recorded.
// Matched case-insensitively against the recorded header keys.
const SENSITIVE_HEADER_KEYS = new Set([
  "authorization",
  "proxy-authorization",
  "cookie",
  "set-cookie",
  "x-api-key",
  "x-auth-token",
  "x-csrf-token",
  "x-csrftoken",
  "x-xsrf-token",
  "vellum-api-key",
]);

// JSON body keys whose values are credentials/tokens. Matched
// case-insensitively against object keys before re-serializing.
const SENSITIVE_BODY_KEYS = new Set([
  "access_token",
  "accesstoken",
  "api_key",
  "apikey",
  "authorization",
  "client_secret",
  "code",
  "id_token",
  "password",
  "private_key",
  "refresh_token",
  "secret",
  "session",
  "token",
]);

type HeaderBag = { [key: string]: string | null | undefined };

function scrubHeaders(headers: HeaderBag): HeaderBag {
  const next: HeaderBag = {};
  for (const [key, value] of Object.entries(headers)) {
    next[key] = SENSITIVE_HEADER_KEYS.has(key.toLowerCase()) ? REDACTED : value;
  }
  return next;
}

function scrubJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(scrubJsonValue);
  if (value && typeof value === "object") {
    const next: Record<string, unknown> = {};
    for (const [key, inner] of Object.entries(value as Record<string, unknown>)) {
      next[key] = SENSITIVE_BODY_KEYS.has(key.toLowerCase())
        ? REDACTED
        : scrubJsonValue(inner);
    }
    return next;
  }
  return value;
}

/**
 * Redact token-shaped fields from a recorded body. Only JSON bodies are
 * deep-scrubbed; non-JSON bodies are left as-is (URLs and headers are the
 * primary credential carriers and are handled separately). A body that
 * fails to round-trip through JSON is dropped entirely to fail closed.
 */
function scrubBody(body: string | undefined): string | undefined {
  if (!body) return body;
  let parsed: unknown;
  try {
    parsed = JSON.parse(body);
  } catch {
    return body;
  }
  try {
    return JSON.stringify(scrubJsonValue(parsed));
  } catch {
    return REDACTED;
  }
}

/**
 * Exported for unit testing. Strips credential-bearing headers, scrubs
 * token-shaped JSON body fields, and sanitizes the URL before a recorded
 * request enters a LogRocket session.
 */
export function requestSanitizer(request: LogRocketRequest): LogRocketRequest {
  request.url = sanitizeUrl(request.url);
  request.headers = scrubHeaders(request.headers);
  request.body = scrubBody(request.body);
  return request;
}

/** Exported for unit testing. Response counterpart to {@link requestSanitizer}. */
export function responseSanitizer(response: LogRocketResponse): LogRocketResponse {
  if (typeof response.url === "string") response.url = sanitizeUrl(response.url);
  response.headers = scrubHeaders(response.headers);
  response.body = scrubBody(response.body);
  return response;
}

const options: LogRocketOptions = {
  release: import.meta.env.VITE_APP_VERSION,
  shouldCaptureIP: false,
  // Authoritative per-upload consent gate. `init()` runs at most once, but
  // this is consulted live before each send, so flipping the toggle off (or
  // a stale consent version) stops uploads without a teardown API.
  shouldSendData: () => logRocketConsentGranted(),
  dom: {
    inputSanitizer: true,
  },
  browser: {
    urlSanitizer: (url: string) => sanitizeUrl(url),
  },
  network: {
    requestSanitizer,
    responseSanitizer,
  },
};

/**
 * Bootstrap LogRocket consent gating. Must be called after
 * `migrateDeviceSettings()` so the `device:share_product_improvement` key is
 * available when the consent gate reads localStorage. No-ops entirely when
 * `VITE_LOGROCKET_APP_ID` is unset (the feature stays dark).
 */
export function initLogRocket(): void {
  const appId = import.meta.env.VITE_LOGROCKET_APP_ID;
  if (!appId) return;
  syncLogRocketClient(appId, options);
  installLogRocketControlListeners(appId, options);
}
