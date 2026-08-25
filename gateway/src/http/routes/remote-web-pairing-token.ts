import type {
  RemoteWebPairingPlatform,
  RemoteWebPairingTokenApprovedResponse,
  RemoteWebPairingTokenPendingResponse,
} from "@vellumai/service-contracts/remote-web-pairing";
import {
  DEFAULT_REMOTE_WEB_PAIRING_PLATFORM,
  REMOTE_WEB_PAIRING_PLATFORMS,
} from "@vellumai/service-contracts/remote-web-pairing";

import type { RefreshableTokenPair } from "../../auth/guardian-bootstrap.js";
import {
  ensureVellumGuardianBinding,
  getExternalAssistantId,
  mintAndRecordBrowserTokenPair,
  mintAndRecordDeviceBoundTokenPair,
  VellumGuardianMintRefusedError,
} from "../../auth/guardian-bootstrap.js";
import {
  claimRemoteWebPairingChallengeExchange,
  completeRemoteWebPairingChallengeExchange,
  releaseRemoteWebPairingChallengeExchange,
} from "../../remote-web/pairing-challenge-store.js";
import {
  buildRemoteWebBrowserAuthCookies,
  remoteWebRefreshCookiePathForPublicBaseUrl,
} from "../browser-auth-cookies.js";
import { errorResponse } from "../loopback-guard.js";
import {
  jsonStringField,
  methodNotAllowed,
  readJsonObjectBody,
} from "../route-helpers.js";

const MAX_TOKEN_BODY_BYTES = 512;
const REMOTE_WEB_PLATFORM = "web";

/**
 * The requested platform, coerced to a known value. Unlike loopback `/v1/pair`,
 * this route is publicly reachable and its platform renders verbatim in the
 * host's paired-devices list, so an unrecognized value never reaches the DB.
 */
function resolveDevicePlatform(raw: unknown): RemoteWebPairingPlatform {
  const known = REMOTE_WEB_PAIRING_PLATFORMS.find(
    (platform) => platform === raw,
  );
  return known ?? DEFAULT_REMOTE_WEB_PAIRING_PLATFORM;
}

/** Token-exchange JSON responses, errors included, are never cacheable. */
function noStore(res: Response): Response {
  res.headers.set("Cache-Control", "no-store");
  return res;
}

function invalidDeviceCodeResponse(): Response {
  return noStore(
    errorResponse(
      "INVALID_OR_EXPIRED_DEVICE_CODE",
      "invalid or expired pairing device code",
      401,
    ),
  );
}

export async function handleRemoteWebPairingToken(
  req: Request,
): Promise<Response> {
  if (req.method !== "POST") {
    return methodNotAllowed("POST");
  }

  const body = await readJsonObjectBody(req, MAX_TOKEN_BODY_BYTES);
  if (body instanceof Response) {
    return noStore(body);
  }
  const deviceCode = jsonStringField(body, "deviceCode");
  if (!deviceCode) {
    return noStore(errorResponse("BAD_REQUEST", "deviceCode is required", 400));
  }
  // Sent by a trusted host exchanging for itself, never by a browser. The
  // device code is the credential either way; the id only selects per-device
  // revocability and body-delivered refresh.
  const deviceId = jsonStringField(body, "deviceId");

  const challenge = claimRemoteWebPairingChallengeExchange(deviceCode);
  if (challenge.status === "pending") {
    const pending: RemoteWebPairingTokenPendingResponse = {
      status: "pending",
      expiresAt: challenge.expiresAt,
      intervalSeconds: challenge.intervalSeconds,
    };
    return Response.json(pending, {
      status: 202,
      headers: { "Cache-Control": "no-store" },
    });
  }
  if (
    challenge.status === "invalid" ||
    challenge.status === "expired" ||
    challenge.status === "consumed"
  ) {
    return invalidDeviceCodeResponse();
  }

  let guardianPrincipalId: string;
  let pair: RefreshableTokenPair;
  // Set on the browser path only: a device-bound pairing carries its refresh
  // token in the body, so there is no cookie to scope.
  let refreshCookiePath: string | null = null;
  try {
    guardianPrincipalId = await ensureVellumGuardianBinding();
    if (deviceId) {
      pair = mintAndRecordDeviceBoundTokenPair({
        guardianPrincipalId,
        deviceId,
        platform: resolveDevicePlatform(body.platform),
      });
    } else {
      refreshCookiePath = remoteWebRefreshCookiePathForPublicBaseUrl(
        challenge.publicBaseUrl,
      );
      pair = mintAndRecordBrowserTokenPair({
        guardianPrincipalId,
        platform: REMOTE_WEB_PLATFORM,
        browserRefreshCookiePath: refreshCookiePath,
      });
    }
  } catch (err) {
    // Release so the approved code stays exchangeable after the failure is
    // repaired (mint refusal) or retried (transient DB error).
    releaseRemoteWebPairingChallengeExchange(deviceCode);
    if (err instanceof VellumGuardianMintRefusedError) {
      // Guardian rows lost but the DB shows prior onboarding: minting here
      // would diverge from prior clients' tokens. Fail closed with an
      // explicit repair-required response instead of an unhandled 500.
      // Stays 503 (unlike /auth/token's repairable 401): 401 here means
      // invalid/expired device code, and the released code stays
      // exchangeable after guardian repair.
      return noStore(
        errorResponse(
          "GUARDIAN_REPAIR_REQUIRED",
          "gateway guardian binding is missing over evidence of prior onboarding; repair via guardian init, then retry pairing",
          503,
        ),
      );
    }
    throw err;
  }
  completeRemoteWebPairingChallengeExchange(deviceCode);

  const headers = new Headers({ "Cache-Control": "no-store" });
  const approved: RemoteWebPairingTokenApprovedResponse = {
    status: "approved",
    accessToken: pair.accessToken,
    accessTokenExpiresAt: new Date(pair.accessTokenExpiresAt).toISOString(),
    refreshAfter: new Date(pair.refreshAfter).toISOString(),
    guardianId: guardianPrincipalId,
    assistantId: getExternalAssistantId(),
  };

  if (refreshCookiePath) {
    for (const cookie of buildRemoteWebBrowserAuthCookies({
      refreshToken: pair.refreshToken,
      refreshTokenExpiresAtMs: pair.refreshTokenExpiresAt,
      refreshCookiePath,
    })) {
      headers.append("Set-Cookie", cookie);
    }
  } else {
    approved.refreshToken = pair.refreshToken;
    approved.refreshTokenExpiresAt = new Date(
      pair.refreshTokenExpiresAt,
    ).toISOString();
  }

  return Response.json(approved, { headers });
}
