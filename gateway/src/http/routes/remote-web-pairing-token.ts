import type {
  RemoteWebPairingTokenApprovedResponse,
  RemoteWebPairingTokenPendingResponse,
} from "@vellumai/service-contracts/remote-web-pairing";
import { resolveRemoteWebPairingPlatform } from "@vellumai/service-contracts/remote-web-pairing";

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

const MAX_TOKEN_BODY_BYTES = 1024;
const REMOTE_WEB_PLATFORM = "web";

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
  // A blank deviceId is a client bug, not a browser exchange: falling through
  // to the cookie path would hand a host a credential it cannot read.
  if (deviceId === null && typeof body.deviceId === "string") {
    return noStore(
      errorResponse("BAD_REQUEST", "deviceId must not be blank", 400),
    );
  }
  // The single discriminator for both minting and delivery. Everything the
  // browser path needs beyond it is data, never the branch condition.
  const deviceBound = deviceId !== null;
  const clientReportedName = jsonStringField(body, "clientReportedName");

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

  // The exchange request's own User-Agent, not the challenge's stored
  // requesterUserAgent: in the app-handoff flow the phone's browser mints
  // the code but the app performs the exchange and holds the credential, so
  // the exchange request is the one that observed the actual device.
  const exchangeUserAgent = req.headers.get("user-agent");
  const identity = {
    pairingUserAgent: exchangeUserAgent,
    clientReportedName,
  };
  let guardianPrincipalId: string;
  let pair: RefreshableTokenPair;
  // Set on the browser path only: a device-bound pairing carries its refresh
  // token in the body, so there is no cookie to scope.
  let refreshCookiePath: string | undefined;
  try {
    guardianPrincipalId = await ensureVellumGuardianBinding();
    if (deviceBound) {
      pair = mintAndRecordDeviceBoundTokenPair({
        guardianPrincipalId,
        deviceId,
        platform: resolveRemoteWebPairingPlatform(body.platform),
        identity,
      });
    } else {
      refreshCookiePath = remoteWebRefreshCookiePathForPublicBaseUrl(
        challenge.publicBaseUrl,
      );
      pair = mintAndRecordBrowserTokenPair({
        guardianPrincipalId,
        platform: REMOTE_WEB_PLATFORM,
        browserRefreshCookiePath: refreshCookiePath,
        identity,
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

  // Delivery follows the same discriminator the mint did. A browser exchange
  // never serializes its refresh token into the body, whatever the cookie
  // path helper returns.
  if (deviceBound) {
    approved.refreshToken = pair.refreshToken;
    approved.refreshTokenExpiresAt = new Date(
      pair.refreshTokenExpiresAt,
    ).toISOString();
  } else {
    for (const cookie of buildRemoteWebBrowserAuthCookies({
      refreshToken: pair.refreshToken,
      refreshTokenExpiresAtMs: pair.refreshTokenExpiresAt,
      refreshCookiePath,
    })) {
      headers.append("Set-Cookie", cookie);
    }
  }

  return Response.json(approved, { headers });
}
