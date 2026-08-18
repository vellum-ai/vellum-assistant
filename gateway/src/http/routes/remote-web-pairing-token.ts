import type {
  RemoteWebPairingTokenApprovedResponse,
  RemoteWebPairingTokenPendingResponse,
} from "@vellumai/service-contracts/remote-web-pairing";

import {
  ensureVellumGuardianBinding,
  getExternalAssistantId,
  mintAndRecordBrowserTokenPair,
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
import { methodNotAllowed, readJsonStringField } from "../route-helpers.js";

const MAX_TOKEN_BODY_BYTES = 512;
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

  const deviceCode = await readJsonStringField(
    req,
    MAX_TOKEN_BODY_BYTES,
    "deviceCode",
  );
  if (deviceCode instanceof Response) {
    return noStore(deviceCode);
  }

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

  const refreshCookiePath = remoteWebRefreshCookiePathForPublicBaseUrl(
    challenge.publicBaseUrl,
  );
  let guardianPrincipalId: string;
  let pair: ReturnType<typeof mintAndRecordBrowserTokenPair>;
  try {
    guardianPrincipalId = await ensureVellumGuardianBinding();
    pair = mintAndRecordBrowserTokenPair({
      guardianPrincipalId,
      platform: REMOTE_WEB_PLATFORM,
      browserRefreshCookiePath: refreshCookiePath,
    });
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
  for (const cookie of buildRemoteWebBrowserAuthCookies({
    refreshToken: pair.refreshToken,
    refreshTokenExpiresAtMs: pair.refreshTokenExpiresAt,
    refreshCookiePath,
  })) {
    headers.append("Set-Cookie", cookie);
  }

  const approved: RemoteWebPairingTokenApprovedResponse = {
    status: "approved",
    accessToken: pair.accessToken,
    accessTokenExpiresAt: new Date(pair.accessTokenExpiresAt).toISOString(),
    refreshAfter: new Date(pair.refreshAfter).toISOString(),
    guardianId: guardianPrincipalId,
    assistantId: getExternalAssistantId(),
  };
  return Response.json(approved, { headers });
}
