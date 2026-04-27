/**
 * Route handler for `POST /v1/browser-extension-pair`.
 *
 * Mints a short-lived, scoped `host_browser_command` capability token for a
 * chrome extension running on the same machine as the gateway.
 *
 * Security properties:
 *   - **Localhost-only**: enforced by both the TCP peer IP (via
 *     `server.requestIP`) and the `Host` header. Non-localhost callers
 *     receive a 403.
 *   - **Browser-origin rejection**: if an `Origin` header is present it
 *     must be either empty or explicitly on the
 *     `getAllowedExtensionOrigins()` allowlist. This defends against a
 *     malicious web page in another tab issuing a cross-origin POST from
 *     the user's browser — such a request would carry the page's origin
 *     and would be rejected here even if it somehow reached loopback.
 *   - **Strict rate limiting**: a dedicated per-peer sliding-window
 *     limiter caps pair requests at 10/minute per peer IP.
 *   - **Audit logs on denial**: every rejected request emits a structured
 *     warn log.
 *   - **Origin allowlist**: the body must include `extensionOrigin`
 *     matching an allowlist of known Vellum chrome extension ids.
 *
 * Request body:  `{ extensionOrigin: string }` (also accepts the legacy
 *                 `{ origin: string }` for backwards compatibility).
 * Response body: `{ token, expiresAt, guardianId }` — `expiresAt` is an
 *                 ISO 8601 timestamp string.
 */

import { readFileSync } from "node:fs";
import { join } from "node:path";

import { mintHostBrowserCapability } from "../../auth/capability-tokens.js";
import { getAssistantDb } from "../../auth/guardian-bootstrap.js";
import { getLogger } from "../../logger.js";
import { getGatewaySecurityDir } from "../../paths.js";
import { isLoopbackAddress } from "../../util/is-loopback-address.js";

const log = getLogger("browser-extension-pair");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const BROWSER_EXTENSION_PAIR_RATE_LIMIT_MAX_REQUESTS = 10;
const BROWSER_EXTENSION_PAIR_RATE_LIMIT_WINDOW_MS = 60_000;

const BROWSER_EXTENSION_PAIR_EXTENSION_ID_REGEX = /^[a-p]{32}$/;

/** Daemon's internal assistant scope identifier. */
const BROWSER_EXTENSION_PAIR_DAEMON_INTERNAL_ASSISTANT_ID = "self";

// ---------------------------------------------------------------------------
// Rate limiter (dedicated, per-peer)
// ---------------------------------------------------------------------------

interface RateLimitEntry {
  timestamps: number[];
}

const rateLimitMap = new Map<string, RateLimitEntry>();

function checkRateLimit(peerIp: string): {
  allowed: boolean;
  limit: number;
  resetAt: number;
} {
  const now = Date.now();
  const windowStart = now - BROWSER_EXTENSION_PAIR_RATE_LIMIT_WINDOW_MS;

  let entry = rateLimitMap.get(peerIp);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitMap.set(peerIp, entry);
  }

  // Prune timestamps outside the window
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  if (
    entry.timestamps.length >= BROWSER_EXTENSION_PAIR_RATE_LIMIT_MAX_REQUESTS
  ) {
    const oldestInWindow = entry.timestamps[0] ?? now;
    const resetAt = Math.ceil(
      (oldestInWindow + BROWSER_EXTENSION_PAIR_RATE_LIMIT_WINDOW_MS) / 1000,
    );
    return {
      allowed: false,
      limit: BROWSER_EXTENSION_PAIR_RATE_LIMIT_MAX_REQUESTS,
      resetAt,
    };
  }

  entry.timestamps.push(now);
  return {
    allowed: true,
    limit: BROWSER_EXTENSION_PAIR_RATE_LIMIT_MAX_REQUESTS,
    resetAt: Math.ceil(
      (now + BROWSER_EXTENSION_PAIR_RATE_LIMIT_WINDOW_MS) / 1000,
    ),
  };
}

/** Test helper: clear the rate limiter state. */
export function resetBrowserExtensionPairRateLimiterForTests(): void {
  rateLimitMap.clear();
}

// ---------------------------------------------------------------------------
// Chrome extension allowlist
// ---------------------------------------------------------------------------

type ChromeExtensionAllowlistConfig = {
  version: number;
  allowedExtensionIds: string[];
};

function parseAllowedExtensionIds(
  value: unknown,
  opts: { allowEmpty?: boolean } = {},
): string[] {
  if (!Array.isArray(value)) {
    throw new Error("allowedExtensionIds is not an array");
  }
  const ids = value
    .filter((id): id is string => typeof id === "string")
    .filter((id) => BROWSER_EXTENSION_PAIR_EXTENSION_ID_REGEX.test(id));
  if (ids.length === 0 && !opts.allowEmpty) {
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
    .filter((id) => BROWSER_EXTENSION_PAIR_EXTENSION_ID_REGEX.test(id));
  return Array.from(new Set(ids));
}

function readIdsFromFile(
  path: string,
  opts: { allowEmpty?: boolean } = {},
): string[] {
  const raw = readFileSync(path, "utf8");
  const parsed = JSON.parse(raw) as Partial<ChromeExtensionAllowlistConfig>;
  return parseAllowedExtensionIds(parsed.allowedExtensionIds, opts);
}

function loadAllowedExtensionOrigins(): ReadonlySet<string> {
  const merged = new Set<string>();
  const loadErrors: string[] = [];

  // 1. Local override in $GATEWAY_SECURITY_DIR. Optional — a missing file
  //    is not an error.
  const localOverridePath = join(
    getGatewaySecurityDir(),
    "chrome-extension-allowlist.local.json",
  );
  try {
    for (const id of readIdsFromFile(localOverridePath, {
      allowEmpty: true,
    })) {
      merged.add(`chrome-extension://${id}/`);
    }
  } catch (err) {
    const isMissing =
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT";
    if (!isMissing) {
      const detail = err instanceof Error ? err.message : String(err);
      loadErrors.push(`${localOverridePath}: ${detail}`);
    }
  }

  // 2. Env-var fallback. Compiled Bun binaries run from a virtual FS root
  //    so file-based config paths can disappear in packaged builds;
  //    `VELLUM_CHROME_EXTENSION_IDS` is set at compile time for that case.
  for (const id of loadAllowedExtensionIdsFromEnv()) {
    merged.add(`chrome-extension://${id}/`);
  }

  if (merged.size === 0) {
    log.error(
      {
        localOverridePath,
        loadErrors,
      },
      "Failed to load Chrome extension allowlist from any source; pairing will reject all origins",
    );
  } else if (loadErrors.length > 0) {
    log.warn(
      { loadErrors },
      "Chrome extension allowlist load errors — using env vars only",
    );
  }

  return merged;
}

let _allowedExtensionOrigins: ReadonlySet<string> | null = null;

export function getAllowedExtensionOrigins(): ReadonlySet<string> {
  if (!_allowedExtensionOrigins) {
    _allowedExtensionOrigins = loadAllowedExtensionOrigins();
  }
  return _allowedExtensionOrigins;
}

/** Test helper: clear the cached allowlist. */
export function resetAllowedExtensionOriginsForTests(): void {
  _allowedExtensionOrigins = null;
}

// ---------------------------------------------------------------------------
// Host header parsing
// ---------------------------------------------------------------------------

/**
 * Parse an HTTP `Host` header value and extract the hostname portion.
 */
export function parseHostHeader(raw: string): string | null {
  if (raw.length === 0) return null;
  if (raw.startsWith("[")) {
    const end = raw.indexOf("]");
    if (end < 0) return null;
    const after = raw.substring(end + 1);
    if (after.length > 0 && !after.startsWith(":")) return null;
    return raw.substring(1, end);
  }
  const firstColon = raw.indexOf(":");
  if (firstColon < 0) return raw;
  const secondColon = raw.indexOf(":", firstColon + 1);
  if (secondColon >= 0) {
    return raw;
  }
  return raw.substring(0, firstColon);
}

function isLoopbackHostHeader(host: string | null): boolean {
  if (!host) return true;
  const parsed = parseHostHeader(host);
  if (parsed === null) return false;
  const hostname = parsed.toLowerCase();
  if (hostname === "localhost") return true;
  return isLoopbackAddress(hostname);
}

// ---------------------------------------------------------------------------
// Guardian resolution
// ---------------------------------------------------------------------------

interface GuardianLookupRow {
  principal_id: string | null;
}

function resolveLocalGuardianId(): string {
  try {
    const db = getAssistantDb();
    const row = db
      .query<GuardianLookupRow, []>(
        `SELECT c.principal_id
         FROM contacts c
         INNER JOIN contact_channels cc ON cc.contact_id = c.id
         WHERE c.role = 'guardian'
           AND cc.type = 'vellum'
           AND cc.status = 'active'
         ORDER BY cc.verified_at DESC
         LIMIT 1`,
      )
      .get();
    if (row?.principal_id) {
      return row.principal_id;
    }
  } catch (err) {
    log.warn(
      { err },
      "Failed to look up local vellum guardian; falling back to 'local'",
    );
  }
  return "local";
}

// ---------------------------------------------------------------------------
// Audit logging
// ---------------------------------------------------------------------------

function auditDeny(
  req: Request,
  peerIp: string,
  reason: string,
  extra?: Record<string, unknown>,
): void {
  const host = req.headers.get("host");
  const origin = req.headers.get("origin");
  log.warn(
    {
      audit: "browser-extension-pair-denied",
      peerIp,
      host,
      origin,
      reason,
      ...extra,
    },
    `pair_denied: ${reason}`,
  );
}

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

function errorResponse(
  code: string,
  message: string,
  status: number,
): Response {
  return Response.json({ error: { code, message } }, { status });
}

function getExternalAssistantId(): string {
  return (
    process.env.VELLUM_ASSISTANT_NAME?.trim() ||
    BROWSER_EXTENSION_PAIR_DAEMON_INTERNAL_ASSISTANT_ID
  );
}

/**
 * Handle POST /v1/browser-extension-pair.
 *
 * `clientIp` is the resolved peer IP from the gateway's `getClientIp()`
 * helper (which reads `server.requestIP(req)`).
 */
export async function handleBrowserExtensionPair(
  req: Request,
  clientIp: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  // Enforce localhost-only via peer IP.
  if (!clientIp || !isLoopbackAddress(clientIp)) {
    auditDeny(req, clientIp, "non_loopback_peer");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

  // Secondary check: Host header.
  const host = req.headers.get("host");
  if (!isLoopbackHostHeader(host)) {
    auditDeny(req, clientIp, "non_loopback_host_header");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

  // Reject proxied requests.
  if (req.headers.get("x-forwarded-for")) {
    auditDeny(req, clientIp, "x_forwarded_for_present");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

  // Strict rate limit by peer IP.
  const rateResult = checkRateLimit(clientIp);
  if (!rateResult.allowed) {
    auditDeny(req, clientIp, "rate_limited", {
      limit: rateResult.limit,
      resetAt: rateResult.resetAt,
    });
    const retryAfter = Math.max(
      1,
      rateResult.resetAt - Math.ceil(Date.now() / 1000),
    );
    return Response.json(
      { error: { code: "RATE_LIMITED", message: "too many pair requests" } },
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

  // Browser-origin rejection.
  const originHeader = req.headers.get("origin");
  if (originHeader !== null && originHeader.length > 0) {
    const withSlash = `${originHeader}/`;
    if (
      !getAllowedExtensionOrigins().has(originHeader) &&
      !getAllowedExtensionOrigins().has(withSlash)
    ) {
      auditDeny(req, clientIp, "browser_origin_not_allowlisted", {
        originHeader,
      });
      return errorResponse("FORBIDDEN", "origin not allowed", 403);
    }
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    auditDeny(req, clientIp, "invalid_json_body");
    return errorResponse("BAD_REQUEST", "invalid JSON body", 400);
  }

  if (!body || typeof body !== "object") {
    auditDeny(req, clientIp, "body_not_object");
    return errorResponse("BAD_REQUEST", "body must be an object", 400);
  }

  const raw = body as { extensionOrigin?: unknown; origin?: unknown };
  const extensionOrigin =
    typeof raw.extensionOrigin === "string" && raw.extensionOrigin.length > 0
      ? raw.extensionOrigin
      : typeof raw.origin === "string" && raw.origin.length > 0
        ? raw.origin
        : null;
  if (extensionOrigin === null) {
    auditDeny(req, clientIp, "missing_extension_origin");
    return errorResponse("BAD_REQUEST", "extensionOrigin is required", 400);
  }

  if (!getAllowedExtensionOrigins().has(extensionOrigin)) {
    auditDeny(req, clientIp, "extension_origin_not_allowlisted", {
      extensionOrigin,
    });
    return errorResponse("FORBIDDEN", "extension origin not allowed", 403);
  }

  const guardianId = resolveLocalGuardianId();
  const { token, expiresAt } = mintHostBrowserCapability(guardianId);
  const expiresAtIso = new Date(expiresAt).toISOString();

  log.info(
    { extensionOrigin, guardianId, expiresAt: expiresAtIso },
    "Browser extension paired successfully",
  );

  return Response.json({
    token,
    expiresAt: expiresAtIso,
    guardianId,
    assistantId: getExternalAssistantId(),
  });
}
