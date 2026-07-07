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
import { readLimitedBody } from "../read-limited-body.js";

const MAX_TOKEN_BODY_BYTES = 512;
const REMOTE_WEB_PLATFORM = "web";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function invalidDeviceCodeResponse(): Response {
  return jsonError(
    "INVALID_OR_EXPIRED_DEVICE_CODE",
    "invalid or expired pairing device code",
    401,
  );
}

export async function handleRemoteWebPairingToken(
  req: Request,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const rawBody = await readLimitedBody(req, MAX_TOKEN_BODY_BYTES);
  if (rawBody.status === "too_large") {
    return jsonError("PAYLOAD_TOO_LARGE", "request body too large", 413);
  }
  if (rawBody.status === "unreadable") {
    return jsonError("BAD_REQUEST", "failed to read request body", 400);
  }

  let deviceCode: string | null = null;
  try {
    const body = JSON.parse(rawBody.text) as { deviceCode?: unknown };
    deviceCode =
      typeof body.deviceCode === "string" && body.deviceCode.trim()
        ? body.deviceCode
        : null;
  } catch {
    return jsonError("BAD_REQUEST", "invalid JSON body", 400);
  }

  if (!deviceCode) {
    return jsonError("BAD_REQUEST", "deviceCode is required", 400);
  }

  const challenge = claimRemoteWebPairingChallengeExchange(deviceCode);
  if (challenge.status === "pending") {
    return Response.json(
      {
        status: "pending",
        expiresAt: challenge.expiresAt,
        intervalSeconds: challenge.intervalSeconds,
      },
      { status: 202, headers: { "Cache-Control": "no-store" } },
    );
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
      return jsonError(
        "GUARDIAN_REPAIR_REQUIRED",
        "gateway guardian binding is missing over evidence of prior onboarding — repair via guardian init, then retry pairing",
        503,
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

  return Response.json(
    {
      status: "approved",
      accessToken: pair.accessToken,
      accessTokenExpiresAt: new Date(pair.accessTokenExpiresAt).toISOString(),
      refreshAfter: new Date(pair.refreshAfter).toISOString(),
      guardianId: guardianPrincipalId,
      assistantId: getExternalAssistantId(),
    },
    { headers },
  );
}
