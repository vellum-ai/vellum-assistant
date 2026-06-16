import { approveRemoteWebPairingChallenge } from "../../remote-web/pairing-challenge-store.js";
import {
  checkRemoteWebPairingVerificationRateLimit,
  clearRemoteWebPairingVerificationFailures,
  recordRemoteWebPairingVerificationFailure,
  type RemoteWebPairingVerificationRateLimit,
} from "../../remote-web/pairing-verification-rate-limit-store.js";

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

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
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  let userCode: string | null = null;
  try {
    const body = (await req.json()) as { userCode?: unknown };
    userCode =
      typeof body.userCode === "string" && body.userCode.trim()
        ? body.userCode
        : null;
  } catch {
    return failedAttemptResponse(
      clientIp,
      jsonError("BAD_REQUEST", "invalid JSON body", 400),
    );
  }

  if (!userCode) {
    return failedAttemptResponse(
      clientIp,
      jsonError("BAD_REQUEST", "userCode is required", 400),
    );
  }

  const rateLimited = checkRemoteWebPairingVerificationRateLimit(clientIp);
  if (rateLimited) return rateLimitedResponse(rateLimited);

  const result = approveRemoteWebPairingChallenge(userCode);
  if (result.status === "invalid") {
    return failedAttemptResponse(
      clientIp,
      jsonError("INVALID_USER_CODE", "invalid pairing code", 404),
    );
  }
  if (result.status === "expired") {
    return failedAttemptResponse(
      clientIp,
      jsonError("EXPIRED_USER_CODE", "pairing code expired", 410),
    );
  }

  clearRemoteWebPairingVerificationFailures(clientIp);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
