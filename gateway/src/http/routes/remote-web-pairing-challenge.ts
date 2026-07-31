import {
  checkRemoteWebPairingChallengeCapacity,
  createRemoteWebPairingChallenge,
  type RemoteWebPairingChallengeCapacityLimit,
} from "../../remote-web/pairing-challenge-store.js";
import {
  recordRemoteWebPairingChallengeCreation,
  type RemoteWebPairingChallengeRateLimit,
} from "../../remote-web/pairing-challenge-rate-limit-store.js";
import { isLoopbackAddress } from "../../util/is-loopback-address.js";
import { requestArrivedViaEdgeProxy } from "../edge-forwarded-header.js";
import { enforceLoopbackOnly, parseHostHeader } from "../loopback-guard.js";
import { readLimitedBody } from "../read-limited-body.js";

const MAX_CHALLENGE_BODY_BYTES = 512;

function parsePublicBaseUrl(value: unknown): string | null {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" && url.protocol !== "http:") return null;
    if (!url.host) return null;
    const pathPrefix = url.pathname.replace(/\/+$/, "");
    return `${url.origin}${pathPrefix}`;
  } catch {
    return null;
  }
}

function jsonError(code: string, message: string, status: number): Response {
  return Response.json({ error: { code, message } }, { status });
}

function rateLimitedResponse(
  rateLimit: RemoteWebPairingChallengeRateLimit,
): Response {
  return Response.json(
    {
      error: {
        code: "RATE_LIMITED",
        message: "too many remote web pairing challenges",
      },
    },
    {
      status: 429,
      headers: { "Retry-After": String(rateLimit.retryAfterSeconds) },
    },
  );
}

function capacityLimitedResponse(
  capacityLimit: RemoteWebPairingChallengeCapacityLimit,
): Response {
  return Response.json(
    {
      error: {
        code: "PAIRING_CHALLENGE_CAPACITY_EXCEEDED",
        message: "too many pending remote web pairing challenges",
      },
    },
    {
      status: 429,
      headers: { "Retry-After": String(capacityLimit.retryAfterSeconds) },
    },
  );
}

function publicBaseUrlMatchesRequestHost(
  req: Request,
  publicBaseUrl: string,
): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  const parsedHost = parseHostHeader(host);
  if (!parsedHost) return false;

  const publicUrl = new URL(publicBaseUrl);
  return publicUrl.hostname.toLowerCase() === parsedHost.toLowerCase();
}

export async function handleCreateRemoteWebPairingChallenge(
  req: Request,
  clientIp: string,
  rawPeerIp = clientIp,
): Promise<Response> {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }

  const arrivedViaEdgeProxy = requestArrivedViaEdgeProxy(req);
  const arrivedViaTrustedEdgeProxy =
    arrivedViaEdgeProxy && isLoopbackAddress(rawPeerIp);
  if (!arrivedViaTrustedEdgeProxy) {
    const guardError = enforceLoopbackOnly(
      req,
      clientIp,
      "remote-web-pairing-challenge",
    );
    if (guardError) return guardError;
  }

  const rawBody = await readLimitedBody(req, MAX_CHALLENGE_BODY_BYTES);
  if (rawBody.status === "too_large") {
    return jsonError("PAYLOAD_TOO_LARGE", "request body too large", 413);
  }
  if (rawBody.status === "unreadable") {
    return jsonError("BAD_REQUEST", "failed to read request body", 400);
  }

  let publicBaseUrl: string | null = null;
  try {
    const body = JSON.parse(rawBody.text) as { publicBaseUrl?: unknown };
    publicBaseUrl = parsePublicBaseUrl(body.publicBaseUrl);
  } catch {
    return jsonError("BAD_REQUEST", "invalid JSON body", 400);
  }

  if (!publicBaseUrl) {
    return jsonError("BAD_REQUEST", "publicBaseUrl is required", 400);
  }

  if (
    arrivedViaTrustedEdgeProxy &&
    !publicBaseUrlMatchesRequestHost(req, publicBaseUrl)
  ) {
    return jsonError(
      "PUBLIC_BASE_URL_MISMATCH",
      "publicBaseUrl must match the request host",
      400,
    );
  }

  const rateLimited = recordRemoteWebPairingChallengeCreation();
  if (rateLimited) return rateLimitedResponse(rateLimited);

  const capacityLimited = checkRemoteWebPairingChallengeCapacity();
  if (capacityLimited) return capacityLimitedResponse(capacityLimited);

  const challenge = createRemoteWebPairingChallenge(publicBaseUrl);

  return Response.json(challenge, {
    headers: { "Cache-Control": "no-store" },
  });
}
