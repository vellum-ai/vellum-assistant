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
 * Response body: `{ token, expiresAt, guardianId, assistantId }`. The
 * device-bound path (a `deviceId` is supplied) additionally returns
 * `{ refreshToken, refreshTokenExpiresAt, refreshAfter }` so the client can
 * renew via `/v1/guardian/refresh` instead of re-pairing.
 */

import { mintAndRecordDeviceBoundTokenPair } from "../../auth/guardian-bootstrap.js";
import { CURRENT_POLICY_EPOCH } from "../../auth/policy.js";
import { mintToken } from "../../auth/token-service.js";
import { KNOWN_EXTENSION_ORIGINS } from "../../chrome-extension-origins.js";
import { assistantDbQuery } from "../../db/assistant-db-proxy.js";
import { getLogger } from "../../logger.js";
import { enforceLoopbackOnly, errorResponse } from "../loopback-guard.js";

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
// Guardian resolution
// ---------------------------------------------------------------------------

interface GuardianPrincipalRow {
  principalId: string | null;
}

export async function resolveLocalGuardianPrincipalId(): Promise<string> {
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

  // Loopback-only boundary (Velay/edge markers, peer IP, Host header,
  // X-Forwarded-For) — shared with the other local-machine endpoints.
  const guardError = enforceLoopbackOnly(req, clientIp, "pair");
  if (guardError) return guardError;

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

    // Device-bound path: mint a recorded, per-device-revocable access token.
    if (deviceId) {
      return mintDeviceBoundPairResponse({
        guardianPrincipalId,
        assistantId,
        deviceId,
        platform: bodyPlatform ?? interfaceId,
        interfaceId,
        clientId,
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

  // CLI pairing (e.g. `vellum pair`): a loopback-local caller mints a
  // device-bound token for another machine. The loopback / X-Forwarded-For /
  // edge-marker guards above are the boundary. A deviceId is required — CLI
  // pairing is always device-scoped (and thus revocable).
  if (interfaceId === "cli") {
    // A real `vellum pair` is a terminal process and never sends an Origin
    // header; any Origin means a browser/WebView is calling (e.g. dynamic
    // surface JS at https://<appId>.vellum.local). Reject it: combined with the
    // gateway's WebView CORS allowance, such JS could otherwise mint and read
    // back a broadly-scoped actor_client_v1 token. (A local non-browser process
    // omitting Origin can still mint — that's the intentional loopback trust
    // model; this guard closes the browser/WebView sandbox-escape vector.)
    const origin = req.headers.get("origin");
    if (origin) {
      auditDeny(req, clientIp, "cli_browser_origin", { origin });
      return errorResponse("FORBIDDEN", "endpoint is local-only", 403);
    }
    if (!deviceId) {
      return errorResponse(
        "BAD_REQUEST",
        "cli interface requires a deviceId",
        400,
      );
    }
    return mintDeviceBoundPairResponse({
      guardianPrincipalId,
      assistantId,
      deviceId,
      platform: bodyPlatform ?? "cli",
      interfaceId,
      clientId,
    });
  }

  auditDeny(req, clientIp, "unknown_interface", { interfaceId });
  return errorResponse(
    "BAD_REQUEST",
    `unsupported interface: '${interfaceId}'`,
    400,
  );
}

/**
 * Mint a device-bound, recorded, per-device-revocable credential and build the
 * pair response. Shared by the chrome-extension (deviceId) and cli pairing
 * paths.
 *
 * Issues the standard access + long-lived device-scoped refresh token pair, so
 * a paired client renews via `/v1/guardian/refresh` instead of re-pairing.
 * Both are revocable per device on the hot path (actor-token revocation is
 * enforced on live requests), and the refresh endpoint rejects revoked/rotated
 * tokens — so revocation, not a short TTL, bounds a leaked token's reach. The
 * access TTL matches what `/v1/guardian/refresh` mints on rotation, so it stays
 * consistent across the token's life (rather than 24h at mint then 30d after
 * the first refresh).
 */
function mintDeviceBoundPairResponse(opts: {
  guardianPrincipalId: string;
  assistantId: string;
  deviceId: string;
  platform: string;
  interfaceId: string;
  clientId: string | null;
}): Response {
  const pair = mintAndRecordDeviceBoundTokenPair({
    guardianPrincipalId: opts.guardianPrincipalId,
    deviceId: opts.deviceId,
    platform: opts.platform,
  });

  log.info(
    {
      interfaceId: opts.interfaceId,
      clientId: opts.clientId,
      guardianPrincipalId: opts.guardianPrincipalId,
      platform: opts.platform,
    },
    "Client paired successfully via loopback (device-bound)",
  );

  return Response.json({
    token: pair.accessToken,
    expiresAt: new Date(pair.accessTokenExpiresAt).toISOString(),
    refreshToken: pair.refreshToken,
    refreshTokenExpiresAt: new Date(pair.refreshTokenExpiresAt).toISOString(),
    refreshAfter: new Date(pair.refreshAfter).toISOString(),
    guardianId: opts.guardianPrincipalId,
    assistantId: opts.assistantId,
  });
}
