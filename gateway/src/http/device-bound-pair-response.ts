/**
 * Shared builder for device-bound pairing responses.
 *
 * Every pairing path that issues device-scoped credentials — loopback `/v1/pair`
 * (chrome-extension and cli) and the public QR-code exchange — mints the same
 * access + refresh token pair and returns the same body shape via this helper,
 * so the credential contract can't drift between them.
 */

import { mintAndRecordDeviceBoundTokenPair } from "../auth/guardian-bootstrap.js";
import { getLogger } from "../logger.js";

const log = getLogger("device-bound-pair");

/**
 * Mint a device-bound, recorded, per-device-revocable credential and build the
 * pair response.
 *
 * Issues the standard access + long-lived device-scoped refresh token pair, so
 * a paired client renews via `/v1/guardian/refresh` instead of re-pairing.
 * Both are revocable per device on the hot path (actor-token revocation is
 * enforced on live requests), and the refresh endpoint rejects revoked/rotated
 * tokens — so revocation, not a short TTL, bounds a leaked token's reach. The
 * access TTL matches what `/v1/guardian/refresh` mints on rotation, so it stays
 * consistent across the token's life (rather than 24h at mint then 30d after
 * the first refresh).
 *
 * The response carries `Cache-Control: no-store` so the token pair is never
 * cached by an intermediary on the internet-facing exchange path.
 */
export function mintDeviceBoundPairResponse(opts: {
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
    "Client paired successfully (device-bound)",
  );

  return Response.json(
    {
      token: pair.accessToken,
      expiresAt: new Date(pair.accessTokenExpiresAt).toISOString(),
      refreshToken: pair.refreshToken,
      refreshTokenExpiresAt: new Date(pair.refreshTokenExpiresAt).toISOString(),
      refreshAfter: new Date(pair.refreshAfter).toISOString(),
      guardianId: opts.guardianPrincipalId,
      assistantId: opts.assistantId,
    },
    { headers: { "Cache-Control": "no-store" } },
  );
}
