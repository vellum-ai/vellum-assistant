import { approveRemoteWebPairingChallenge } from "../../remote-web/pairing-challenge-store.js";

const RATE_LIMIT_MAX_FAILURES = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

interface RateLimitEntry {
  timestamps: number[];
}

const failureRateLimitByIp = new Map<string, RateLimitEntry>();

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function checkFailureRateLimit(clientIp: string): Response | null {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  const entry = failureRateLimitByIp.get(clientIp);
  if (!entry) return null;

  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
  if (entry.timestamps.length === 0) {
    failureRateLimitByIp.delete(clientIp);
    return null;
  }
  if (entry.timestamps.length < RATE_LIMIT_MAX_FAILURES) return null;

  const resetAtMs = entry.timestamps[0] + RATE_LIMIT_WINDOW_MS;
  const retryAfter = Math.max(1, Math.ceil((resetAtMs - now) / 1000));
  return Response.json(
    {
      error: {
        code: "RATE_LIMITED",
        message: "too many invalid pairing verification attempts",
      },
    },
    { status: 429, headers: { "Retry-After": String(retryAfter) } },
  );
}

function recordFailure(clientIp: string): void {
  const now = Date.now();
  const windowStart = now - RATE_LIMIT_WINDOW_MS;
  let entry = failureRateLimitByIp.get(clientIp);
  if (!entry) {
    entry = { timestamps: [] };
    failureRateLimitByIp.set(clientIp, entry);
  }
  entry.timestamps = entry.timestamps.filter((t) => t > windowStart);
  entry.timestamps.push(now);
}

function clearFailures(clientIp: string): void {
  failureRateLimitByIp.delete(clientIp);
}

function failedAttemptResponse(clientIp: string, response: Response): Response {
  const rateLimited = checkFailureRateLimit(clientIp);
  if (rateLimited) return rateLimited;
  recordFailure(clientIp);
  return response;
}

export function resetRemoteWebPairingVerificationRateLimiterForTests(): void {
  failureRateLimitByIp.clear();
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

  clearFailures(clientIp);
  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}
