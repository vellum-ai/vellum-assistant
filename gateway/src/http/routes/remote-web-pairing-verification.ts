import { approveRemoteWebPairingChallenge } from "../../remote-web/pairing-challenge-store.js";
import {
  checkRemoteWebPairingVerificationRateLimit,
  clearRemoteWebPairingVerificationFailures,
  recordRemoteWebPairingVerificationFailure,
  type RemoteWebPairingVerificationRateLimit,
} from "../../remote-web/pairing-verification-rate-limit-store.js";
import { enforceLoopbackOnly, errorResponse } from "../loopback-guard.js";
import { methodNotAllowed, readJsonStringField } from "../route-helpers.js";

const MAX_VERIFICATION_BODY_BYTES = 256;

function rateLimitedResponse(
  rateLimit: RemoteWebPairingVerificationRateLimit,
): Response {
  return Response.json(
    {
      error: {
        code: "RATE_LIMITED",
        message: "too many invalid pairing verification attempts",
      },
    },
    {
      status: 429,
      headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
    },
  );
}

function failedAttemptResponse(clientIp: string, response: Response): Response {
  const rateLimited = checkRemoteWebPairingVerificationRateLimit(clientIp);
  if (rateLimited) return rateLimitedResponse(rateLimited);
  recordRemoteWebPairingVerificationFailure(clientIp);
  return response;
}

export async function handleVerifyRemoteWebPairingChallenge(
  req: Request,
  clientIp: string,
): Promise<Response> {
  if (req.method !== "POST") {
    return methodNotAllowed("POST");
  }

  const guardError = enforceLoopbackOnly(
    req,
    clientIp,
    "remote-web-pairing-verification",
  );
  if (guardError) return guardError;

  const rateLimitedBeforeBodyRead =
    checkRemoteWebPairingVerificationRateLimit(clientIp);
  if (rateLimitedBeforeBodyRead) {
    return rateLimitedResponse(rateLimitedBeforeBodyRead);
  }

  // Body/JSON/field failures count as failed attempts for the per-client
  // rate limiter.
  const userCode = await readJsonStringField(
    req,
    MAX_VERIFICATION_BODY_BYTES,
    "userCode",
  );
  if (userCode instanceof Response) {
    return failedAttemptResponse(clientIp, userCode);
  }

  const rateLimitedBeforeCodeCheck =
    checkRemoteWebPairingVerificationRateLimit(clientIp);
  if (rateLimitedBeforeCodeCheck) {
    return rateLimitedResponse(rateLimitedBeforeCodeCheck);
  }

  const result = approveRemoteWebPairingChallenge(userCode);
  if (result.status === "invalid") {
    return failedAttemptResponse(
      clientIp,
      errorResponse("INVALID_USER_CODE", "invalid pairing code", 404),
    );
  }
  if (result.status === "expired") {
    return failedAttemptResponse(
      clientIp,
      errorResponse("EXPIRED_USER_CODE", "pairing code expired", 410),
    );
  }

  clearRemoteWebPairingVerificationFailures(clientIp);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
