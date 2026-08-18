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
import { methodNotAllowed, readJsonStringField } from "../route-helpers.js";

const MAX_ACTION_BODY_BYTES = 256;
const AUDIT_TAG = "remote-web-pairing-requests";

export function handleListRemoteWebPairingRequests(
  req: Request,
  clientIp: string,
): Response {
  if (req.method !== "GET") {
    return methodNotAllowed("GET");
  }

  const guardError = enforceLoopbackOnly(req, clientIp, AUDIT_TAG);
  if (guardError) {
    return guardError;
  }

  return Response.json(
    {
      requests: listPendingRemoteWebPairingChallenges(),
    } satisfies RemoteWebPairingRequestListResponse,
    { headers: { "Cache-Control": "no-store" } },
  );
}

function guardPostLoopback(req: Request, clientIp: string): Response | null {
  if (req.method !== "POST") {
    return methodNotAllowed("POST");
  }
  return enforceLoopbackOnly(req, clientIp, AUDIT_TAG);
}

// No code-guess rate limiter on approve/deny: request ids are server-minted
// opaque ids from the list route, not guessable secrets typed by users.
export async function handleApproveRemoteWebPairingRequest(
  req: Request,
  clientIp: string,
): Promise<Response> {
  const guardError = guardPostLoopback(req, clientIp);
  if (guardError) {
    return guardError;
  }

  const requestId = await readJsonStringField(
    req,
    MAX_ACTION_BODY_BYTES,
    "requestId",
  );
  if (requestId instanceof Response) {
    return requestId;
  }

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
  if (guardError) {
    return guardError;
  }

  const requestId = await readJsonStringField(
    req,
    MAX_ACTION_BODY_BYTES,
    "requestId",
  );
  if (requestId instanceof Response) {
    return requestId;
  }

  const result = denyRemoteWebPairingChallengeById(requestId);
  if (result.status === "invalid") {
    return errorResponse("INVALID_REQUEST_ID", "unknown pairing request", 404);
  }
  if (result.status === "already_approved") {
    return errorResponse(
      "ALREADY_APPROVED",
      "this pairing request was already approved on another surface",
      409,
    );
  }

  return Response.json(
    { status: "denied" } satisfies RemoteWebPairingRequestDenyResponse,
    { headers: { "Cache-Control": "no-store" } },
  );
}
