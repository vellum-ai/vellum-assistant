/**
 * Route handler for `POST /v1/pair/qr-exchange`.
 *
 * Public exchange endpoint for QR pairing. A phone presents the single-use code
 * minted by the host (`POST /v1/pair/qr-code`) together with its `deviceId` and
 * receives device-bound access + refresh tokens — the same credential shape as
 * the loopback device-bound pair flow. There is no prior auth: the code IS the
 * credential, and possession proves the presenter physically saw the host's
 * screen.
 *
 * Security posture (internet-facing):
 *   - **Flag-gated**: gated behind `web-remote-ingress`; when disabled the route
 *     404s so a host that has not opted into remote web ingress exposes no
 *     pairing surface at all.
 *   - **Atomic single-use burn**: the code is burned before tokens are minted,
 *     so a concurrent second exchange of the same code fails.
 *   - **Uniform failure**: every invalid / expired / already-burned code returns
 *     the same error, so an attacker cannot probe which codes exist.
 *   - **Rate limited**: strict per-IP request cap as flood defence-in-depth.
 */

import { getExternalAssistantId } from "../../auth/guardian-bootstrap.js";
import { isFeatureFlagEnabled } from "../../feature-flag-resolver.js";
import { getLogger } from "../../logger.js";
import { claimQrPairingCode } from "../../remote-web/qr-pairing-code-store.js";
import {
  checkQrPairingExchangeRateLimit,
  type QrPairingExchangeRateLimit,
} from "../../remote-web/qr-pairing-exchange-rate-limit-store.js";
import { mintDeviceBoundPairResponse } from "../device-bound-pair-response.js";
import { readLimitedBody } from "../read-limited-body.js";
import { resolveLocalGuardianPrincipalId } from "./pair.js";

const WEB_REMOTE_INGRESS_FLAG = "web-remote-ingress";
const MAX_EXCHANGE_BODY_BYTES = 512;
const QR_PAIRING_INTERFACE = "qr";
const log = getLogger("pair-qr-exchange");

function jsonError(code: string, message: string, status: number): Response {
  return Response.json(
    { error: { code, message } },
    { status, headers: { "Cache-Control": "no-store" } },
  );
}

function rateLimitedResponse(rateLimit: QrPairingExchangeRateLimit): Response {
  return Response.json(
    {
      error: { code: "RATE_LIMITED", message: "too many QR pairing attempts" },
    },
    {
      status: 429,
      headers: {
        "Retry-After": String(rateLimit.retryAfterSeconds),
        "Cache-Control": "no-store",
      },
    },
  );
}

/** Uniform failure for every invalid / expired / already-burned code. */
function invalidCodeResponse(): Response {
  return jsonError(
    "INVALID_OR_EXPIRED_QR_CODE",
    "invalid or expired pairing code",
    401,
  );
}

export async function handleQrPairingExchange(
  req: Request,
  clientIp: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  // Fail closed and invisible when remote web ingress is not enabled: the host
  // has not opted into any browser/QR pairing surface.
  if (!isFeatureFlagEnabled(WEB_REMOTE_INGRESS_FLAG)) {
    return jsonError("NOT_FOUND", "not found", 404);
  }

  const rateLimited = checkQrPairingExchangeRateLimit(clientIp);
  if (rateLimited) return rateLimitedResponse(rateLimited);

  const rawBody = await readLimitedBody(req, MAX_EXCHANGE_BODY_BYTES);
  if (rawBody.status === "too_large") {
    return jsonError("PAYLOAD_TOO_LARGE", "request body too large", 413);
  }
  if (rawBody.status === "unreadable") {
    return jsonError("BAD_REQUEST", "failed to read request body", 400);
  }

  let code: string | null = null;
  let deviceId: string | null = null;
  try {
    const body = JSON.parse(rawBody.text) as {
      code?: unknown;
      deviceId?: unknown;
    };
    code =
      typeof body.code === "string" && body.code.trim()
        ? body.code.trim()
        : null;
    deviceId =
      typeof body.deviceId === "string" && body.deviceId.trim()
        ? body.deviceId.trim()
        : null;
  } catch {
    return jsonError("BAD_REQUEST", "invalid JSON body", 400);
  }

  if (!code || !deviceId) {
    return jsonError("BAD_REQUEST", "code and deviceId are required", 400);
  }

  // Atomic single-use burn happens before any token is minted, so a concurrent
  // second exchange of the same code loses the race and fails here.
  const claim = claimQrPairingCode(code);
  if (claim.status !== "ok") {
    return invalidCodeResponse();
  }

  const guardianPrincipalId = await resolveLocalGuardianPrincipalId();
  const assistantId = getExternalAssistantId();

  log.info(
    { guardianPrincipalId },
    "QR pairing code exchanged for device-bound tokens",
  );

  return mintDeviceBoundPairResponse({
    guardianPrincipalId,
    assistantId,
    deviceId,
    platform: QR_PAIRING_INTERFACE,
    interfaceId: QR_PAIRING_INTERFACE,
    clientId: null,
  });
}
