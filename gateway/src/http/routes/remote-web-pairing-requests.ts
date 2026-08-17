/**
 * Host-approval routes for remote-web pairing requests: list the pending
 * challenges, then approve or deny one by its server-minted request id. This
 * is the surface behind the settings "Pair a device" approval UI (see the
 * header comment in
 * `clients/web/src/domains/settings/pair-device/pair-device-client.ts`).
 *
 * All three routes are loopback-gated and unauthenticated: running on the
 * host IS the authorization, exactly like the pairing-challenge/verification
 * routes. A remote paired session must never reach them, which the server-side
 * loopback guard enforces regardless of any client-side hiding.
 */

import type {
  RemoteWebPairingRequestDenyResponse,
  RemoteWebPairingRequestListResponse,
} from "@vellumai/service-contracts/remote-web-pairing";

import {
  approveRemoteWebPairingChallengeById,
  denyRemoteWebPairingChallengeById,
  listPendingRemoteWebPairingChallenges,
} from "../../remote-web/pairing-challenge-store.js";
import { enforceLoopbackOnly, errorResponse } from "../loopback-guard.js";
import { readLimitedBody } from "../read-limited-body.js";

const MAX_ACTION_BODY_BYTES = 256;
const AUDIT_TAG = "remote-web-pairing-requests";

export function handleListRemoteWebPairingRequests(
  req: Request,
  clientIp: string,
): Response {
  if (req.method !== "GET") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "GET" },
    });
  }

  const guardError = enforceLoopbackOnly(req, clientIp, AUDIT_TAG);
  if (guardError) return guardError;

  return Response.json(
    {
      requests: listPendingRemoteWebPairingChallenges(),
    } satisfies RemoteWebPairingRequestListResponse,
    { headers: { "Cache-Control": "no-store" } },
  );
}

function guardPostLoopback(req: Request, clientIp: string): Response | null {
  if (req.method !== "POST") {
    return new Response("method not allowed", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  return enforceLoopbackOnly(req, clientIp, AUDIT_TAG);
}

async function readRequestIdBody(req: Request): Promise<string | Response> {
  const rawBody = await readLimitedBody(req, MAX_ACTION_BODY_BYTES);
  if (rawBody.status === "too_large") {
    return errorResponse("PAYLOAD_TOO_LARGE", "request body too large", 413);
  }
  if (rawBody.status === "unreadable") {
    return errorResponse("BAD_REQUEST", "failed to read request body", 400);
  }

  let requestId: string | null = null;
  try {
    const body = JSON.parse(rawBody.text) as { requestId?: unknown };
    requestId =
      typeof body.requestId === "string" && body.requestId.trim()
        ? body.requestId
        : null;
  } catch {
    return errorResponse("BAD_REQUEST", "invalid JSON body", 400);
  }

  return (
    requestId ?? errorResponse("BAD_REQUEST", "requestId is required", 400)
  );
}

// No code-guess rate limiter on approve/deny: request ids are server-minted
// opaque ids from the list route, not guessable secrets typed by users.
export async function handleApproveRemoteWebPairingRequest(
  req: Request,
  clientIp: string,
): Promise<Response> {
  const guardError = guardPostLoopback(req, clientIp);
  if (guardError) return guardError;

  const requestId = await readRequestIdBody(req);
  if (requestId instanceof Response) return requestId;

  const result = approveRemoteWebPairingChallengeById(requestId);
  if (result.status === "invalid") {
    return errorResponse("INVALID_REQUEST_ID", "unknown pairing request", 404);
  }
  if (result.status === "expired") {
    return errorResponse("EXPIRED_REQUEST", "pairing request expired", 410);
  }

  return Response.json(result, { headers: { "Cache-Control": "no-store" } });
}

export async function handleDenyRemoteWebPairingRequest(
  req: Request,
  clientIp: string,
): Promise<Response> {
  const guardError = guardPostLoopback(req, clientIp);
  if (guardError) return guardError;

  const requestId = await readRequestIdBody(req);
  if (requestId instanceof Response) return requestId;

  const result = denyRemoteWebPairingChallengeById(requestId);
  if (result.status === "invalid") {
    return errorResponse("INVALID_REQUEST_ID", "unknown pairing request", 404);
  }

  return Response.json(
    { status: "denied" } satisfies RemoteWebPairingRequestDenyResponse,
    { headers: { "Cache-Control": "no-store" } },
  );
}
