/**
 * Route handler for `POST /v1/pair`.
 *
 * Generic loopback pairing endpoint. Any client connecting from the local
 * machine (loopback IP) can obtain a short-lived capability token to interact
 * with the assistant via the browser-relay protocol.
 *
 * The security model is:
 *
 *   - **Loopback-only**: enforced by both the TCP peer IP (via
 *     `server.requestIP`) and the `Host` header. Non-localhost callers
 *     receive a 403.
 *   - **No proxied requests**: rejects requests with `X-Forwarded-For`.
 *   - **Rate limiting**: per-peer sliding-window limiter caps pair requests
 *     at 10/minute per peer IP.
 *   - **Audit logging**: every rejected request emits a structured warn log.
 *
 * The client declares its type via the standard `X-Vellum-Interface-Id`
 * header (e.g. `chrome-extension`). This determines which capability token
 * is minted. Currently supported: `chrome-extension` → `host_browser_command`.
 *
 * Response body: `{ token, expiresAt, guardianId, assistantId }`
 */

import { mintHostBrowserCapability } from "../../auth/capability-tokens.js";
import { assistantDbQuery } from "../../db/assistant-db-proxy.js";
import { getLogger } from "../../logger.js";
import { isLoopbackAddress } from "../../util/is-loopback-address.js";

const log = getLogger("pair");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

const DAEMON_INTERNAL_ASSISTANT_ID = "self";

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
  const windowStart = now - RATE_LIMIT_WINDOW_MS;

  let entry = rateLimitMap.get(peerIp);
  if (!entry) {
    entry = { timestamps: [] };
    rateLimitMap.set(peerIp, entry);
  }

  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);

  if (entry.timestamps.length >= RATE_LIMIT_MAX_REQUESTS) {
    const oldestInWindow = entry.timestamps[0] ?? now;
    const resetAt = Math.ceil(
      (oldestInWindow + RATE_LIMIT_WINDOW_MS) / 1000,
    );
    return {
      allowed: false,
      limit: RATE_LIMIT_MAX_REQUESTS,
      resetAt,
    };
  }

  entry.timestamps.push(now);
  return {
    allowed: true,
    limit: RATE_LIMIT_MAX_REQUESTS,
    resetAt: Math.ceil((now + RATE_LIMIT_WINDOW_MS) / 1000),
  };
}

/** Test helper: clear the rate limiter state. */
export function resetPairRateLimiterForTests(): void {
  rateLimitMap.clear();
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

async function resolveLocalGuardianId(): Promise<string> {
  try {
    const rows = await assistantDbQuery<GuardianLookupRow>(
      `SELECT c.principal_id
       FROM contacts c
       INNER JOIN contact_channels cc ON cc.contact_id = c.id
       WHERE c.role = 'guardian'
         AND cc.type = 'vellum'
         AND cc.status = 'active'
       ORDER BY cc.verified_at DESC
       LIMIT 1`,
    );
    if (rows[0]?.principal_id) {
      return rows[0].principal_id;
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
      audit: "pair-denied",
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
    process.env.VELLUM_ASSISTANT_NAME?.trim() || DAEMON_INTERNAL_ASSISTANT_ID
  );
}

/**
 * Handle POST /v1/pair.
 *
 * Any loopback client can call this to obtain a capability token.
 * The client identifies itself via the `X-Vellum-Interface-Id` header,
 * which determines the capability minted.
 */
export async function handlePair(
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

  // Rate limit by peer IP.
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

  // Read the interface from the standard X-Vellum-Interface-Id header.
  const interfaceId = req.headers.get("x-vellum-interface-id");
  const clientId = req.headers.get("x-vellum-client-id");

  if (!interfaceId) {
    return errorResponse(
      "BAD_REQUEST",
      "missing required header: X-Vellum-Interface-Id",
      400,
    );
  }

  const guardianId = await resolveLocalGuardianId();

  // Dispatch capability minting based on the declared interface.
  if (interfaceId === "chrome-extension") {
    const { token, expiresAt } = mintHostBrowserCapability(guardianId);
    const expiresAtIso = new Date(expiresAt).toISOString();

    log.info(
      { interfaceId, clientId, guardianId, expiresAt: expiresAtIso },
      "Client paired successfully via loopback",
    );

    return Response.json({
      token,
      expiresAt: expiresAtIso,
      guardianId,
      assistantId: getExternalAssistantId(),
    });
  }

  // Unknown interface — reject for now. New interfaces can be added here.
  auditDeny(req, clientIp, "unknown_interface", { interfaceId });
  return errorResponse(
    "BAD_REQUEST",
    `unsupported interface: '${interfaceId}'`,
    400,
  );
}
