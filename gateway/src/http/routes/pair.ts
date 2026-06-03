/**
 * Route handler for `POST /v1/pair`.
 *
 * Generic loopback pairing endpoint. Any client connecting from the local
 * machine (loopback IP) can obtain a short-lived JWT to authenticate
 * subsequent requests to the assistant runtime (e.g. host-browser callbacks).
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
 * header (e.g. `chrome-extension`). The returned JWT uses the
 * `actor_client_v1` scope profile (includes `approval.write`) and is valid
 * as a gateway edge token — send it as `Authorization: Bearer <token>` on
 * subsequent runtime requests.
 *
 * Response body: `{ token, expiresAt, guardianId, assistantId }`
 */

import { mintAndRecordDeviceBoundTokenPair } from "../../auth/guardian-bootstrap.js";
import { CURRENT_POLICY_EPOCH } from "../../auth/policy.js";
import { mintToken } from "../../auth/token-service.js";
import { KNOWN_EXTENSION_ORIGINS } from "../../chrome-extension-origins.js";
import { assistantDbQuery } from "../../db/assistant-db-proxy.js";
import { getLogger } from "../../logger.js";
import { isLoopbackAddress } from "../../util/is-loopback-address.js";
import { VELAY_FORWARDED_HEADER } from "../../velay/bridge-utils.js";
import { requestArrivedViaEdgeProxy } from "../edge-forwarded-header.js";

const log = getLogger("pair");

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const RATE_LIMIT_MAX_REQUESTS = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

/** Pair tokens are valid for 24 hours — covers extended sessions and SSE reconnects. */
const PAIR_TOKEN_TTL_SECONDS = 86400;

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
    const resetAt = Math.ceil((oldestInWindow + RATE_LIMIT_WINDOW_MS) / 1000);
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

interface GuardianPrincipalRow {
  principalId: string | null;
}

async function resolveLocalGuardianPrincipalId(): Promise<string> {
  try {
    const rows = await assistantDbQuery<GuardianPrincipalRow>(
      `SELECT c.principal_id AS principalId
       FROM contacts c
       JOIN contact_channels cc ON cc.contact_id = c.id
       WHERE c.role = 'guardian' AND cc.type = 'vellum' AND cc.status = 'active'
       LIMIT 1`,
      [],
    );
    if (rows.length > 0 && rows[0].principalId) {
      return rows[0].principalId;
    }
  } catch (err) {
    log.warn(
      { err },
      "Failed to look up local guardian principal; falling back to 'local'",
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

  // Defense-in-depth: reject Velay-bridged requests. The bridge injects this
  // header on every forwarded request; it cannot be stripped by a Velay client.
  if (req.headers.get(VELAY_FORWARDED_HEADER)) {
    auditDeny(req, clientIp, "velay_bridged");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

  // Defense-in-depth: reject requests forwarded by the self-hosted nginx edge
  // (e.g. the SPA reached over an ngrok tunnel). The edge sets this marker
  // unconditionally and it cannot be spoofed or stripped by the client — see
  // edge-forwarded-header.ts. The X-Forwarded-For check below also catches the
  // edge today, but this marker is the explicit, unspoofable signal.
  if (requestArrivedViaEdgeProxy(req)) {
    auditDeny(req, clientIp, "edge_proxy_forwarded");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

  if (!clientIp || !isLoopbackAddress(clientIp)) {
    auditDeny(req, clientIp, "non_loopback_peer");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

  const host = req.headers.get("host");
  if (!isLoopbackHostHeader(host)) {
    auditDeny(req, clientIp, "non_loopback_host_header");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

  if (req.headers.get("x-forwarded-for")) {
    auditDeny(req, clientIp, "x_forwarded_for_present");
    return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
  }

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

  const interfaceId = req.headers.get("x-vellum-interface-id");
  const clientId = req.headers.get("x-vellum-client-id");

  if (!interfaceId) {
    return errorResponse(
      "BAD_REQUEST",
      "missing required header: X-Vellum-Interface-Id",
      400,
    );
  }

  const guardianPrincipalId = await resolveLocalGuardianPrincipalId();
  const assistantId = getExternalAssistantId();

  // Optionally, a client may supply a deviceId to receive a device-bound,
  // DB-recorded, refreshable token pair (revocable per device) instead of the
  // legacy stateless token. The body is optional — a malformed or absent body
  // simply leaves deviceId undefined and preserves the stateless path.
  let deviceId: string | undefined;
  let bodyPlatform: string | undefined;
  if ((req.headers.get("content-type") ?? "").includes("json")) {
    try {
      const body = (await req.json()) as {
        deviceId?: unknown;
        platform?: unknown;
      };
      if (typeof body.deviceId === "string" && body.deviceId.trim()) {
        deviceId = body.deviceId.trim();
      }
      if (typeof body.platform === "string" && body.platform.trim()) {
        bodyPlatform = body.platform.trim();
      }
    } catch {
      // Ignore malformed/empty body — fall back to the stateless path.
    }
  }

  if (interfaceId === "chrome-extension") {
    // Require the request to originate from a known Vellum extension origin.
    //
    // Chrome sets the `Origin: chrome-extension://<id>` header on cross-origin
    // requests from extension service workers and enforces it at the network
    // layer — no extension can impersonate another extension's origin. Combined
    // with Chrome's Private Network Access preflight requirement for localhost
    // access, this ensures only the Vellum extension (across all known
    // environments) can pair via this interface ID.
    //
    // The residual risk is a local process spoofing the Origin header, which
    // bypasses browser enforcement. The loopback IP check above is the
    // defence-in-depth boundary for that case.
    const origin = req.headers.get("origin");
    if (!origin || !KNOWN_EXTENSION_ORIGINS.has(origin)) {
      auditDeny(req, clientIp, "unknown_extension_origin", {
        origin: origin ?? "(none)",
      });
      return errorResponse(
        "FORBIDDEN",
        "origin does not match a known Vellum extension",
        403,
      );
    }

    // Device-bound path: mint a recorded, revocable, refreshable token pair.
    // Keep the access token on the short pair TTL (not the 30-day bootstrap
    // default): until hot-path revocation is enforced, the access JWT is only
    // checked by signature, so a short lifetime bounds its blast radius. The
    // refresh token is long-lived and DB-backed, so the client stays paired by
    // rotating through the refresh endpoint (which honors revocation).
    if (deviceId) {
      const platform = bodyPlatform ?? interfaceId;
      const pair = mintAndRecordDeviceBoundTokenPair({
        guardianPrincipalId,
        deviceId,
        platform,
        accessTtlSeconds: PAIR_TOKEN_TTL_SECONDS,
      });

      log.info(
        { interfaceId, clientId, guardianPrincipalId, platform },
        "Client paired successfully via loopback (device-bound)",
      );

      return Response.json({
        token: pair.accessToken,
        expiresAt: new Date(pair.accessTokenExpiresAt).toISOString(),
        guardianId: guardianPrincipalId,
        assistantId,
        refreshToken: pair.refreshToken,
        refreshAfter: new Date(pair.refreshAfter).toISOString(),
      });
    }

    const expiresAt = Date.now() + PAIR_TOKEN_TTL_SECONDS * 1000;
    const token = mintToken({
      aud: "vellum-gateway",
      sub: `actor:${assistantId}:${guardianPrincipalId}`,
      scope_profile: "actor_client_v1",
      policy_epoch: CURRENT_POLICY_EPOCH,
      ttlSeconds: PAIR_TOKEN_TTL_SECONDS,
    });
    const expiresAtIso = new Date(expiresAt).toISOString();

    log.info(
      { interfaceId, clientId, guardianPrincipalId, expiresAt: expiresAtIso },
      "Client paired successfully via loopback",
    );

    return Response.json({
      token,
      expiresAt: expiresAtIso,
      guardianId: guardianPrincipalId,
      assistantId: getExternalAssistantId(),
    });
  }

  auditDeny(req, clientIp, "unknown_interface", { interfaceId });
  return errorResponse(
    "BAD_REQUEST",
    `unsupported interface: '${interfaceId}'`,
    400,
  );
}
