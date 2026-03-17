/**
 * POST /v1/guardian/init
 *
 * Idempotent bootstrap endpoint for the vellum guardian channel.
 * Creates or confirms a guardianPrincipalId and channel='vellum'
 * guardian binding, then mints and returns a JWT access token bound
 * to (assistantId, guardianPrincipalId) with a paired refresh token.
 *
 * Only the hashed tokens are persisted.
 */

import { createHash } from "node:crypto";

import { v4 as uuid } from "uuid";

import { findGuardianForChannel } from "../../contacts/contact-store.js";
import { createGuardianBinding } from "../../contacts/contacts-write.js";
import { getLogger } from "../../util/logger.js";
import { DAEMON_INTERNAL_ASSISTANT_ID } from "../assistant-scope.js";
import { mintCredentialPair } from "../auth/credential-service.js";
import { httpError } from "../http-errors.js";
import { isPrivateAddress } from "../middleware/auth.js";

/** Bun server shape needed for requestIP -- avoids importing the full Bun type. */
type ServerWithRequestIP = {
  requestIP(
    req: Request,
  ): { address: string; family: string; port: number } | null;
};
import { isHttpAuthDisabled } from "../../config/env.js";

const log = getLogger("guardian-bootstrap");

/** Hash a device ID for storage (same pattern as approved-devices-store). */
function hashDeviceId(deviceId: string): string {
  return createHash("sha256").update(deviceId).digest("hex");
}

/**
 * Ensure a guardianPrincipalId exists for the vellum channel.
 * If a binding already exists, returns the existing guardianExternalUserId
 * as the principal. Otherwise creates a new binding with a fresh principal.
 */
function ensureGuardianPrincipal(assistantId: string): {
  guardianPrincipalId: string;
  isNew: boolean;
} {
  const guardianResult = findGuardianForChannel("vellum");
  if (guardianResult && guardianResult.contact.principalId) {
    return {
      guardianPrincipalId: guardianResult.contact.principalId,
      isNew: false,
    };
  }

  // Mint a new principal ID for the vellum channel
  const guardianPrincipalId = `vellum-principal-${uuid()}`;

  createGuardianBinding({
    channel: "vellum",
    guardianExternalUserId: guardianPrincipalId,
    guardianDeliveryChatId: "local",
    guardianPrincipalId,
    verifiedVia: "bootstrap",
    metadataJson: JSON.stringify({ bootstrappedAt: Date.now() }),
  });

  log.info(
    { assistantId, guardianPrincipalId },
    "Created vellum guardian principal via bootstrap",
  );
  return { guardianPrincipalId, isNew: true };
}

/**
 * Handle POST /v1/guardian/init
 *
 * Body: { platform: 'macos', deviceId: string }
 * Returns: { guardianPrincipalId, accessToken, isNew }
 *
 * This endpoint is restricted to private-network peers (loopback, RFC 1918,
 * Docker bridge, etc.). iOS devices obtain actor tokens exclusively through
 * the QR pairing flow.
 */
export async function handleGuardianBootstrap(
  req: Request,
  server: ServerWithRequestIP,
): Promise<Response> {
  // Reject requests forwarded from public networks. The gateway sets
  // x-forwarded-for to the real client IP; if that IP is on a private
  // network (loopback, Docker bridge, RFC 1918) the request is still
  // considered local. Only reject when the forwarded IP is public.
  const forwarded = req.headers.get("x-forwarded-for");
  const forwardedIp = forwarded ? forwarded.split(",")[0].trim() : null;
  if (forwardedIp && !isPrivateAddress(forwardedIp) && !isHttpAuthDisabled()) {
    return httpError("FORBIDDEN", "Bootstrap endpoint is local-only", 403);
  }

  // Reject non-private-network peers (allows loopback, Docker bridge, etc.)
  const peerIp = server.requestIP(req)?.address;
  if ((!peerIp || !isPrivateAddress(peerIp)) && !isHttpAuthDisabled()) {
    return httpError("FORBIDDEN", "Bootstrap endpoint is local-only", 403);
  }

  try {
    const body = (await req.json()) as Record<string, unknown>;
    const platform =
      typeof body.platform === "string" ? body.platform.trim() : "";
    const deviceId =
      typeof body.deviceId === "string" ? body.deviceId.trim() : "";

    if (!platform || !deviceId) {
      return httpError(
        "BAD_REQUEST",
        "Missing required fields: platform, deviceId",
        400,
      );
    }

    if (platform !== "macos" && platform !== "cli" && platform !== "web") {
      return httpError(
        "BAD_REQUEST",
        "Invalid platform. Bootstrap is macOS/CLI-only; iOS uses QR pairing.",
        400,
      );
    }

    const { guardianPrincipalId, isNew } = ensureGuardianPrincipal(
      DAEMON_INTERNAL_ASSISTANT_ID,
    );
    const hashedDeviceId = hashDeviceId(deviceId);

    // Mint credential pair (access token + refresh token)
    const credentials = mintCredentialPair({
      platform,
      deviceId,
      guardianPrincipalId,
      hashedDeviceId,
    });

    log.info(
      { platform, guardianPrincipalId, isNew },
      "Guardian bootstrap completed",
    );

    return Response.json({
      guardianPrincipalId,
      accessToken: credentials.accessToken,
      accessTokenExpiresAt: credentials.accessTokenExpiresAt,
      refreshToken: credentials.refreshToken,
      refreshTokenExpiresAt: credentials.refreshTokenExpiresAt,
      refreshAfter: credentials.refreshAfter,
      isNew,
    });
  } catch (err) {
    log.error({ err }, "Guardian bootstrap failed");
    return httpError("INTERNAL_ERROR", "Internal server error", 500);
  }
}
