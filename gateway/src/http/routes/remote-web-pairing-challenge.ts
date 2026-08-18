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
import {
  EDGE_CLIENT_IP_HEADER,
  requestArrivedViaEdgeProxy,
} from "../edge-forwarded-header.js";
import {
  enforceLoopbackOnly,
  errorResponse,
  parseHostHeader,
} from "../loopback-guard.js";
import { methodNotAllowed, readJsonStringField } from "../route-helpers.js";

const MAX_CHALLENGE_BODY_BYTES = 512;

function parsePublicBaseUrl(value: string): string | null {
  if (!value.trim()) {
    return null;
  }
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
    return methodNotAllowed("POST");
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

  const rawPublicBaseUrl = await readJsonStringField(
    req,
    MAX_CHALLENGE_BODY_BYTES,
    "publicBaseUrl",
  );
  if (rawPublicBaseUrl instanceof Response) {
    return rawPublicBaseUrl;
  }

  const publicBaseUrl = parsePublicBaseUrl(rawPublicBaseUrl);
  if (!publicBaseUrl) {
    return errorResponse("BAD_REQUEST", "publicBaseUrl is required", 400);
  }

  if (
    arrivedViaTrustedEdgeProxy &&
    !publicBaseUrlMatchesRequestHost(req, publicBaseUrl)
  ) {
    return errorResponse(
      "PUBLIC_BASE_URL_MISMATCH",
      "publicBaseUrl must match the request host",
      400,
    );
  }

  const rateLimited = recordRemoteWebPairingChallengeCreation();
  if (rateLimited) return rateLimitedResponse(rateLimited);

  const capacityLimited = checkRemoteWebPairingChallengeCapacity();
  if (capacityLimited) return capacityLimitedResponse(capacityLimited);

  // The edge stamps the client address it observed via proxy_set_header
  // (overwriting any inbound value), so it is trustworthy exactly when the
  // trusted-edge check above passed. Direct local mints keep the raw peer.
  const edgeClientIp = arrivedViaTrustedEdgeProxy
    ? req.headers.get(EDGE_CLIENT_IP_HEADER)?.trim()
    : undefined;

  const challenge = createRemoteWebPairingChallenge(publicBaseUrl, {
    ip: edgeClientIp || clientIp,
    userAgent: req.headers.get("user-agent"),
    viaEdgeProxy: arrivedViaTrustedEdgeProxy,
  });

  return Response.json(challenge, {
    headers: { "Cache-Control": "no-store" },
  });
}
