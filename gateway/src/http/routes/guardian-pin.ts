/**
 * Pinning a WebSocket upgrade to this assistant's bound guardian.
 *
 * Some surfaces are the owner's own and nobody else's. Live voice runs in the
 * owner's client and the daemon stamps each turn with the guardian's trust
 * context; a watch session reads the owner's screen and the daemon resolves
 * whose screen from the guardian binding rather than from the request. Both
 * proxies replace the caller's identity with `mintServiceToken()` on the way
 * upstream, so the daemon cannot tell one actor from another: whatever the
 * gateway admits is what the daemon treats as the owner. The pin is therefore
 * the only place a non-guardian actor can be stopped.
 *
 * A valid actor edge JWT is not enough on its own. It proves the caller is an
 * actor on this assistant, not that they are the actor the surface belongs to.
 *
 * Two callers, two shapes, because there are two ways a caller arrives:
 *
 * - **Managed / cloud.** Velay validates the browser's token, strips any
 *   client-supplied copies of the `X-Velay-*` headers, and injects the
 *   authenticated caller. That attestation proves the caller is *a* platform
 *   user who traversed velay, so it is cross-checked against the stored
 *   `platform_user_id` by {@link requireManagedGuardian}.
 * - **Self-hosted and everything else.** The caller presents an actor edge JWT
 *   and its principal is compared against the binding by
 *   {@link requireBoundGuardian}.
 *
 * Not every audio proxy wants this. `/v1/stt/stream` carries dictation, which
 * is not a guardian-only surface and accepts any valid actor, which is why the
 * pin is something a route opts into rather than something the shared
 * authorization applies to everything.
 */

import type { Logger } from "pino";

import { findVellumGuardian } from "../../auth/guardian-bootstrap.js";
import { credentialKey } from "../../credential-key.js";
import { readCredential } from "../../credential-reader.js";

const VELAY_USER_ID_HEADER = "x-velay-user-id";
const VELAY_ORG_ID_HEADER = "x-velay-org-id";
const VELAY_ACTOR_HEADER = "x-velay-actor";

/**
 * True when the gateway runs in managed/cloud mode (vembda + velay ingress).
 * Mirrors the `IS_PLATFORM` check used by the gateway's HTTP edge auth
 * (`src/http/middleware/auth.ts`) and feature-flag resolver.
 */
export function isPlatformManaged(): boolean {
  const v = process.env.IS_PLATFORM?.trim().toLowerCase();
  return v === "1" || v === "true";
}

/** Velay-attested managed caller context, extracted from injected headers. */
export type VelayAttestedContext = {
  userId: string;
  orgId: string;
};

/**
 * Extract a velay-attested managed caller context from the upgrade request.
 *
 * Returns null when the request does not carry a complete, well-formed velay
 * attestation (`X-Velay-User-Id` + `X-Velay-Org-Id` both present, with
 * `X-Velay-Actor: user`). Callers MUST only trust the result in managed mode,
 * and only alongside the process-local bridge proof: a direct request to a
 * reachable gateway can spoof the header names but not the proof value.
 */
export function extractVelayAttestedContext(
  req: Request,
): VelayAttestedContext | null {
  const userId = req.headers.get(VELAY_USER_ID_HEADER)?.trim();
  const orgId = req.headers.get(VELAY_ORG_ID_HEADER)?.trim();
  const actor = req.headers.get(VELAY_ACTOR_HEADER)?.trim().toLowerCase();

  if (!userId || !orgId || actor !== "user") {
    return null;
  }
  return { userId, orgId };
}

/**
 * Managed-mode guardian check: cross-check a velay-attested caller's platform
 * user id against the stored `platform_user_id` credential, the same guard the
 * edge-auth middleware applies to guardian routes under the platform bypass.
 *
 * Returns null when the caller is the guardian, else a 403/503 Response.
 */
export async function requireManagedGuardian(
  velayUserId: string,
  log: Logger,
): Promise<Response | null> {
  let storedUserId: string | undefined;
  try {
    storedUserId = await readCredential(
      credentialKey("vellum", "platform_user_id"),
    );
  } catch (err) {
    log.error({ err }, "guardian pin: platform_user_id lookup failed");
    return new Response("Service Unavailable", { status: 503 });
  }
  if (!storedUserId) {
    log.warn("guardian pin: no platform_user_id stored on this assistant");
    return new Response("Forbidden", { status: 403 });
  }
  if (storedUserId !== velayUserId) {
    log.warn("guardian pin: velay caller is not the bound guardian");
    return new Response("Forbidden", { status: 403 });
  }
  return null;
}

/**
 * Actor-JWT guardian check: compare an already-validated actor principal
 * against this assistant's guardian binding.
 *
 * Returns null when the caller is the guardian, else a 403/503 Response. A
 * lookup that throws is 503 rather than 403: the answer is unknown, and
 * failing closed with "forbidden" would misreport a database problem as a
 * permission one.
 */
export async function requireBoundGuardian(
  actorPrincipalId: string,
  log: Logger,
): Promise<Response | null> {
  let guardian: { principalId: string } | null;
  try {
    guardian = await findVellumGuardian();
  } catch (err) {
    log.error({ err }, "guardian pin: findVellumGuardian failed");
    return new Response("Service Unavailable", { status: 503 });
  }
  if (!guardian || guardian.principalId !== actorPrincipalId) {
    log.warn("guardian pin: caller is not the bound guardian");
    return new Response("Forbidden", { status: 403 });
  }
  return null;
}
