/**
 * Route handler for `POST /v1/browser-extension-pair`.
 *
 * Mints a short-lived, scoped `host_browser_command` capability token for a
 * chrome extension that has proved (via the native messaging helper) it is
 * running locally with an allowlisted extension id.
 *
 * Security properties:
 *   - **Localhost-only**: enforced by both the TCP peer IP (via
 *     `server.requestIP`) and the `Host` header. Non-localhost callers
 *     receive a 403.
 *   - **Native-host marker header**: the request must carry the
 *     `x-vellum-native-host: 1` marker. Only the native messaging helper
 *     sets this header; browsers cannot attach custom request headers to
 *     fetches from web pages (custom headers trip CORS preflight, which
 *     this endpoint does not accept). Missing marker header is rejected
 *     with 403.
 *   - **Browser-origin rejection**: if an `Origin` header is present it
 *     must be either empty or explicitly on the
 *     `ALLOWED_EXTENSION_ORIGINS` allowlist. This defends against a
 *     malicious web page in another tab issuing a cross-origin POST from
 *     the user's browser — such a request would carry the page's origin
 *     and would be rejected here even if it somehow reached loopback.
 *   - **Strict rate limiting**: a dedicated per-peer sliding-window
 *     limiter caps pair requests at 10/minute per peer IP. This is
 *     separate from the global API limiter because the pair endpoint
 *     is pre-auth and extra abuse-sensitive.
 *   - **Audit logs on denial**: every rejected request emits a structured
 *     warn log including peer IP, Host header, Origin header, native-host
 *     marker presence, and a reason code so operators can triage denied
 *     attempts.
 *   - **Origin allowlist**: the body must include `extensionOrigin`
 *     matching a hard-coded allowlist of known Vellum chrome extension
 *     ids. This is treated as a secondary defense — the primary gate is
 *     the native-host marker header plus localhost peer check.
 *
 * Request body:  `{ extensionOrigin: string }` (also accepts the legacy
 *                 `{ origin: string }` for backwards compatibility).
 * Response body: `{ token, expiresAt, guardianId }` — `expiresAt` is an
 *                 ISO 8601 timestamp string matching what the native
 *                 messaging helper validates.
 */

import { readFileSync } from "node:fs";
import { resolve } from "node:path";

import { findGuardianForChannel } from "../../contacts/contact-store.js";
import { getLogger } from "../../util/logger.js";
import { mintHostBrowserCapability } from "../capability-tokens.js";
import { httpError } from "../http-errors.js";
import { isLoopbackAddress } from "../middleware/auth.js";
import { TokenRateLimiter } from "../middleware/rate-limiter.js";

const log = getLogger("browser-extension-pair");

/**
 * Header name the native messaging helper MUST set on pair requests.
 * Exported for tests and for the helper to keep in sync. Browsers cannot
 * attach custom headers to fetches from web pages without tripping CORS
 * preflight, which this endpoint does not handle — so a request carrying
 * this header is (by construction) not a drive-by browser call.
 */
export const NATIVE_HOST_MARKER_HEADER = "x-vellum-native-host";

/** Expected value for the native-host marker header. */
export const NATIVE_HOST_MARKER_VALUE = "1";

/**
 * Strict per-peer rate limit for pair requests: 10 requests/minute per
 * loopback peer IP. The native messaging flow only issues one pair
 * request per extension spawn, so this budget is generous for normal
 * use (account for retries on transient failures) while still clamping
 * any abuse surface if a local attacker somehow invokes the endpoint
 * in a tight loop. Exported for tests that need to reset state.
 */
const PAIR_RATE_LIMIT_MAX_REQUESTS = 10;
const PAIR_RATE_LIMIT_WINDOW_MS = 60_000;

/**
 * Dedicated rate limiter instance for the pair endpoint. Keyed on the
 * TCP peer IP (always loopback here, so the key space is tiny and a
 * handful of tracked keys is plenty).
 */
const pairRateLimiter = new TokenRateLimiter(
  PAIR_RATE_LIMIT_MAX_REQUESTS,
  PAIR_RATE_LIMIT_WINDOW_MS,
  64,
);

/** Bun server shape needed for requestIP. */
export type PairServerContext = {
  requestIP(
    req: Request,
  ): { address: string; family: string; port: number } | null;
};

const EXTENSION_ID_REGEX = /^[a-p]{32}$/;
const ALLOWLIST_CONFIG_PATH_CANDIDATES = [
  // Source-checkout / test path (works when running from repo).
  resolve(
    import.meta.dir,
    "..",
    "..",
    "..",
    "..",
    "meta",
    "browser-extension",
    "chrome-extension-allowlist.json",
  ),
  // Repo-root current-working-directory fallback.
  resolve(
    process.cwd(),
    "meta",
    "browser-extension",
    "chrome-extension-allowlist.json",
  ),
];

type ChromeExtensionAllowlistConfig = {
  version: number;
  allowedExtensionIds: string[];
};

function parseAllowedExtensionIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    throw new Error("allowedExtensionIds is not an array");
  }
  const ids = value
    .filter((id): id is string => typeof id === "string")
    .filter((id) => EXTENSION_ID_REGEX.test(id));
  if (ids.length === 0) {
    throw new Error("allowedExtensionIds has no valid extension ids");
  }
  return ids;
}

function loadAllowedExtensionIdsFromEnv(): string[] {
  const raw =
    process.env.VELLUM_CHROME_EXTENSION_IDS ??
    process.env.VELLUM_CHROME_EXTENSION_ID;
  if (!raw) return [];
  const ids = raw
    .split(/[,\s]+/)
    .map((id) => id.trim())
    .filter((id) => id.length > 0)
    .filter((id) => EXTENSION_ID_REGEX.test(id));
  return Array.from(new Set(ids));
}

function loadAllowedExtensionOrigins(): ReadonlySet<string> {
  const loadErrors: string[] = [];
  for (const configPath of ALLOWLIST_CONFIG_PATH_CANDIDATES) {
    try {
      const raw = readFileSync(configPath, "utf8");
      const parsed = JSON.parse(raw) as Partial<ChromeExtensionAllowlistConfig>;
      const ids = parseAllowedExtensionIds(parsed.allowedExtensionIds);
      return new Set<string>(ids.map((id) => `chrome-extension://${id}/`));
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      loadErrors.push(`${configPath}: ${detail}`);
    }
  }

  // Compiled Bun binaries run from a virtual FS root (import.meta.dir is
  // usually `/$bunfs/root`), so repo-relative config paths can disappear in
  // packaged builds. In that case, allow a build-time injected env fallback.
  const envIds = loadAllowedExtensionIdsFromEnv();
  if (envIds.length > 0) {
    return new Set<string>(envIds.map((id) => `chrome-extension://${id}/`));
  }

  log.error(
    {
      allowlistConfigPathCandidates: ALLOWLIST_CONFIG_PATH_CANDIDATES,
      loadErrors,
    },
    "Failed to load Chrome extension allowlist config; pairing will reject all origins",
  );
  return new Set<string>();
}

/**
 * Allowlist of chrome extension origins permitted to request a capability
 * token. Loaded from the canonical config at
 * `meta/browser-extension/chrome-extension-allowlist.json`.
 */
export const ALLOWED_EXTENSION_ORIGINS = loadAllowedExtensionOrigins();

/**
 * Reset the dedicated pair-endpoint rate limiter. Exported for tests
 * so one test's burst can't bleed into another. Production code never
 * calls this.
 *
 * We reach into the private `requests` map via a typed cast rather
 * than adding a `reset()` method to the shared `TokenRateLimiter` —
 * the limiter is a general-purpose utility that other routes also
 * use, and we don't want to pollute its public API with a test-only
 * escape hatch.
 */
export function resetPairRateLimiterForTests(): void {
  const limiter = pairRateLimiter as unknown as {
    requests: Map<string, unknown>;
  };
  limiter.requests.clear();
}

/**
 * Parse an HTTP `Host` header value and extract the hostname portion.
 *
 * Handles IPv6 bracket notation (`[::1]:8765`), unbracketed IPv6
 * (`::1`), hostname with port (`localhost:8765`), and bare hostnames
 * (`localhost`). Returns `null` when the header is malformed (e.g.
 * missing closing bracket, or content after the closing bracket that
 * isn't an optional `:port`).
 *
 * Exported for testing.
 */
export function parseHostHeader(raw: string): string | null {
  if (raw.length === 0) return null;
  // IPv6 literal in brackets, e.g. `[::1]` or `[::1]:8765`.
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0) return null;
    // After the closing bracket only an optional ":port" is valid. Anything
    // else (e.g. `[::1]attacker.com`) is a malformed Host header that an
    // attacker could craft to slip a non-loopback hostname past the parser.
    const after = raw.substring(end + 1);
    if (after.length > 0 && !after.startsWith(":")) return null;
    return raw.substring(1, end);
  }
  // Bare IPv6 (no brackets) contains multiple colons and should be
  // treated as a whole. Anything with a single colon is `host:port`.
  const firstColon = raw.indexOf(":");
  if (firstColon < 0) return raw;
  const secondColon = raw.indexOf(":", firstColon + 1);
  if (secondColon >= 0) {
    // Multiple colons and no brackets — assume unbracketed IPv6.
    return raw;
  }
  return raw.substring(0, firstColon);
}

/**
 * Returns true if the Host header (if present) points at a loopback
 * address. We accept a missing Host header because some HTTP clients
 * (notably node test harnesses) omit it.
 */
function isLoopbackHostHeader(host: string | null): boolean {
  if (!host) return true;
  const parsed = parseHostHeader(host);
  if (parsed === null) return false;
  const hostname = parsed.toLowerCase();
  if (hostname === "localhost") return true;
  if (hostname === "127.0.0.1") return true;
  if (hostname === "::1") return true;
  if (hostname.startsWith("127.")) {
    // Matches the 127.0.0.0/8 loopback range (e.g. 127.0.0.1, 127.1.2.3).
    const parts = hostname.split(".");
    if (parts.length !== 4) return false;
    return parts.every((p) => /^\d+$/.test(p) && Number(p) <= 255);
  }
  return false;
}

/**
 * Resolve the guardian id to bind the capability token to. Phase 2 uses
 * the local vellum guardian principal when one exists, falling back to
 * the string `"local"` for fresh installs that haven't bootstrapped a
 * guardian yet.
 */
function resolveLocalGuardianId(): string {
  try {
    const result = findGuardianForChannel("vellum");
    if (result?.contact.principalId) {
      return result.contact.principalId;
    }
  } catch (err) {
    log.warn(
      { err },
      "Failed to look up local vellum guardian; falling back to 'local'",
    );
  }
  return "local";
}

/**
 * Emit an audit log for a denied pair attempt. Centralizes the field
 * shape (peer IP, host header, origin header, native-host marker
 * presence, reason) so operators can grep for a single log signature
 * when triaging abuse.
 */
function auditDeny(
  req: Request,
  peerIp: string,
  reason: string,
  extra?: Record<string, unknown>,
): void {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  const nativeHostMarker = req.headers.get(NATIVE_HOST_MARKER_HEADER);
  log.warn(
    {
      audit: "browser-extension-pair-denied",
      peerIp,
      host,
      origin,
      nativeHostMarkerPresent: nativeHostMarker !== null,
      reason,
      ...extra,
    },
    `pair_denied: ${reason}`,
  );
}

/**
 * Handle POST /v1/browser-extension-pair.
 *
 * Body:    `{ extensionOrigin: string }` (also accepts legacy
 *          `{ origin: string }` for backwards compatibility).
 * Returns: `{ token, expiresAt, guardianId }` where `expiresAt` is an
 *          ISO 8601 timestamp string that the native messaging helper
 *          validates as a string.
 */
export async function handleBrowserExtensionPair(
  req: Request,
  server: PairServerContext,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  // Enforce localhost-only via peer IP.
  const peer = server.requestIP(req);
  const peerIp = peer?.address ?? "";
  if (!peerIp || !isLoopbackAddress(peerIp)) {
    auditDeny(req, peerIp, "non_loopback_peer");
    return httpError("FORBIDDEN", "endpoint is local-only", 403);
  }

  // Secondary check: Host header. Rejects requests that slip past the
  // TCP-level check via proxies that rewrite the peer address.
  const host = req.headers.get("host");
  if (!isLoopbackHostHeader(host)) {
    auditDeny(req, peerIp, "non_loopback_host_header");
    return httpError("FORBIDDEN", "endpoint is local-only", 403);
  }

  // Any `x-forwarded-for` header indicates the request was proxied from a
  // non-local client. Reject — the pair endpoint is strictly machine-local.
  if (req.headers.get("x-forwarded-for")) {
    auditDeny(req, peerIp, "x_forwarded_for_present");
    return httpError("FORBIDDEN", "endpoint is local-only", 403);
  }

  // Primary marker-header gate. The native messaging helper sets this
  // header on every pair request; browsers cannot (without CORS
  // preflight, which this endpoint does not serve). Reject when the
  // header is absent or set to an unexpected value.
  //
  // IMPORTANT: this check runs BEFORE the rate limiter so that
  // unmarked drive-by POSTs from a malicious webpage cannot burn the
  // legitimate 10/min budget. If the rate limiter ran first, a
  // cross-origin page could issue 10 unmarked requests per minute and
  // starve the native messaging helper's real pair attempts with 429s
  // until the window reset. Unmarked requests therefore return 403
  // without touching the limiter at all.
  const marker = req.headers.get(NATIVE_HOST_MARKER_HEADER);
  if (marker !== NATIVE_HOST_MARKER_VALUE) {
    auditDeny(req, peerIp, "missing_native_host_marker");
    return httpError("FORBIDDEN", "native host marker required", 403);
  }

  // Strict rate limit by peer IP. The limiter is keyed on the loopback
  // peer address; browsers (even local ones) all appear as 127.0.0.1
  // here, which is intentional — a single compromised local process
  // should not be able to hammer the mint endpoint. We evaluate this
  // AFTER the native-host marker check so that unauthenticated
  // drive-by POSTs can't consume the legitimate 10/min quota (see
  // comment above the marker check for the DoS rationale).
  const rateResult = pairRateLimiter.check(
    peerIp,
    "/v1/browser-extension-pair",
  );
  if (!rateResult.allowed) {
    auditDeny(req, peerIp, "rate_limited", {
      limit: rateResult.limit,
      resetAt: rateResult.resetAt,
    });
    const retryAfter = Math.max(
      1,
      rateResult.resetAt - Math.ceil(Date.now() / 1000),
    );
    // Return the same error envelope shape as `httpError` but with
    // Retry-After + X-RateLimit-* headers attached so the native
    // host can back off sensibly. We construct the body inline to
    // avoid cloning / re-consuming a Response returned by
    // `httpError` (Response bodies are one-shot streams).
    return Response.json(
      {
        error: {
          code: "RATE_LIMITED",
          message: "too many pair requests",
        },
      },
      {
        status: 429,
        headers: {
          "Retry-After": String(retryAfter),
          "X-RateLimit-Limit": String(rateResult.limit),
          "X-RateLimit-Remaining": "0",
          "X-RateLimit-Reset": String(rateResult.resetAt),
        },
      },
    );
  }

  // Browser-origin rejection. Any non-empty `Origin` header that isn't
  // on the extension origin allowlist is a cross-origin browser fetch
  // and must be rejected. The native messaging helper sends no Origin
  // header at all (it's a plain node fetch, not a browser fetch), so
  // the common case is `origin === null`.
  const originHeader = req.headers.get("origin");
  if (originHeader !== null && originHeader.length > 0) {
    // Normalize by stripping any trailing slash mismatch: the
    // allowlist entries end with `/` but browsers' Origin headers
    // never include a trailing slash (per RFC 6454 an origin is
    // scheme+host+port with no path). Compare both the bare origin
    // and the `/`-suffixed form against the allowlist.
    const withSlash = `${originHeader}/`;
    if (
      !ALLOWED_EXTENSION_ORIGINS.has(originHeader) &&
      !ALLOWED_EXTENSION_ORIGINS.has(withSlash)
    ) {
      auditDeny(req, peerIp, "browser_origin_not_allowlisted", {
        originHeader,
      });
      return httpError("FORBIDDEN", "origin not allowed", 403);
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    auditDeny(req, peerIp, "invalid_json_body");
    return httpError("BAD_REQUEST", "invalid JSON body", 400);
  }

  if (!body || typeof body !== "object") {
    auditDeny(req, peerIp, "body_not_object");
    return httpError("BAD_REQUEST", "body must be an object", 400);
  }

  // Accept `extensionOrigin` (preferred, matches the native messaging
  // helper) and fall back to `origin` (legacy, for any callers that
  // haven't migrated yet).
  const raw = body as {
    extensionOrigin?: unknown;
    origin?: unknown;
  };
  const extensionOrigin =
    typeof raw.extensionOrigin === "string" && raw.extensionOrigin.length > 0
      ? raw.extensionOrigin
      : typeof raw.origin === "string" && raw.origin.length > 0
        ? raw.origin
        : null;
  if (extensionOrigin === null) {
    auditDeny(req, peerIp, "missing_extension_origin");
    return httpError("BAD_REQUEST", "extensionOrigin is required", 400);
  }

  // Secondary defense: body-level extension origin allowlist. The
  // primary gate is the native-host marker + loopback peer check; this
  // check catches the failure mode where a compromised extension id
  // that doesn't match a known Vellum build still manages to reach
  // the endpoint.
  if (!ALLOWED_EXTENSION_ORIGINS.has(extensionOrigin)) {
    auditDeny(req, peerIp, "extension_origin_not_allowlisted", {
      extensionOrigin,
    });
    return httpError("UNAUTHORIZED", "unauthorized origin", 401);
  }

  const guardianId = resolveLocalGuardianId();
  const { token, expiresAt } = mintHostBrowserCapability(guardianId);
  const expiresAtIso = new Date(expiresAt).toISOString();

  log.info(
    { extensionOrigin, guardianId, expiresAt: expiresAtIso },
    "Issued chrome extension capability token",
  );

  return Response.json({ token, expiresAt: expiresAtIso, guardianId });
}
