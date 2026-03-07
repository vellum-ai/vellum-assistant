/**
 * POST /v1/guardian/refresh
 *
 * Rotates the refresh token and mints a new access token + refresh token pair.
 * This endpoint is the runtime handler proxied through the gateway.
 */

import { getLogger } from "../../util/logger.js";
import { rotateCredentials } from "../auth/credential-service.js";
import { httpError } from "../http-errors.js";
import type { RouteDefinition } from "../http-router.js";

const log = getLogger("guardian-refresh");

/**
 * Handle POST /v1/guardian/refresh
 *
 * Body: { platform: 'ios' | 'macos', deviceId: string, refreshToken: string }
 * Returns: { guardianPrincipalId, accessToken, accessTokenExpiresAt, refreshToken, refreshTokenExpiresAt, refreshAfter }
 */
export async function handleGuardianRefresh(req: Request): Promise<Response> {
  try {
    const body = (await req.json()) as Record<string, unknown>;
    const platform =
      typeof body.platform === "string" ? body.platform.trim() : "";
    const deviceId =
      typeof body.deviceId === "string" ? body.deviceId.trim() : "";
    const refreshToken =
      typeof body.refreshToken === "string" ? body.refreshToken : "";

    if (!platform || !deviceId || !refreshToken) {
      return httpError(
        "BAD_REQUEST",
        "Missing required fields: platform, deviceId, refreshToken",
        400,
      );
    }

    if (platform !== "ios" && platform !== "macos") {
      return httpError(
        "BAD_REQUEST",
        'Invalid platform. Must be "ios" or "macos".',
        400,
      );
    }

    const result = rotateCredentials({ refreshToken, platform, deviceId });

    if (!result.ok) {
      const statusCode =
        result.error === "refresh_reuse_detected"
          ? 403
          : result.error === "device_binding_mismatch"
            ? 403
            : result.error === "revoked"
              ? 403
              : 401;

      log.warn(
        { error: result.error, platform },
        "Refresh token rotation failed",
      );
      return Response.json({ error: result.error }, { status: statusCode });
    }

    log.info(
      { platform, guardianPrincipalId: result.result.guardianPrincipalId },
      "Refresh token rotation succeeded",
    );
    return Response.json(result.result);
  } catch (err) {
    log.error({ err }, "Guardian refresh failed");
    return httpError("INTERNAL_ERROR", "Internal server error", 500);
  }
}

// ---------------------------------------------------------------------------
// Route definitions
// ---------------------------------------------------------------------------

/**
 * Guardian refresh is a pre-auth endpoint (handled before JWT auth in
 * http-server.ts), so these definitions are exported for completeness but
 * are not added to the authenticated route table.
 */
export function guardianRefreshRouteDefinitions(): RouteDefinition[] {
  return [
    {
      endpoint: "guardian/refresh",
      method: "POST",
      handler: async ({ req }) => handleGuardianRefresh(req),
    },
  ];
}
