/**
 * Transport-neutral "is this caller the assistant's owner" check.
 *
 * `requireBoundGuardian` answers the same question from an `AuthContext`, but
 * it is wired into the HTTP adapter through the `requireGuardian` route flag,
 * and the IPC adapter drops every route carrying that flag
 * (`ipc/routes/route-adapter.ts`). A route that must stay reachable from the
 * CLI therefore cannot use the flag, and instead asks this helper from inside
 * the handler, where both transports have already resolved caller identity into
 * headers.
 */

import { isHttpAuthDisabled } from "../../config/env.js";
import {
  getGuardianDelivery,
  getGuardianDeliveryFresh,
  guardianForChannel,
} from "../../contacts/guardian-delivery-reader.js";

/**
 * Whether `actorPrincipalId` is the principal currently bound as the vellum
 * guardian. Fails closed when the binding cannot be read (the gateway is
 * unreachable, so the list comes back null) and when the matching row is not
 * active, which is what makes a revoked or rebound principal stop matching.
 *
 * `fresh` selects the read. The binding is written gateway side and those
 * writes do not invalidate the daemon's cache, so a cached list can describe a
 * binding that was revoked or rebound up to the cache TTL ago. Callers whose
 * threat model is the stale credential itself must pass `fresh: true` and pay
 * one single-flight IPC round trip. It is NOT the default: the established
 * `requireGuardian` routes are host-proxy result callbacks that run once per
 * round trip of an active session, and forcing an uncached read on each would
 * be a hot-path regression for no change in what those routes protect.
 */
export async function matchesBoundGuardian(
  actorPrincipalId: string | undefined,
  options?: { fresh?: boolean },
): Promise<boolean> {
  if (!actorPrincipalId) {
    return false;
  }
  const read = options?.fresh ? getGuardianDeliveryFresh : getGuardianDelivery;
  const guardians = await read({ channelTypes: ["vellum"] });
  if (!guardians) {
    return false;
  }
  const guardian = guardianForChannel(guardians, "vellum");
  return guardian?.principalId === actorPrincipalId;
}

/**
 * Whether the caller holds owner authority over this assistant right now.
 *
 * Two callers qualify:
 *
 * - A **local IPC caller** (the CLI, or another host-resident process). The IPC
 *   socket is host-local and the host is inside the trust boundary.
 * - The **current bound vellum guardian**, identified by matching the verified
 *   `x-vellum-actor-principal-id` against the live binding. This is what keeps
 *   the guardian's own web and desktop clients working, since they arrive as
 *   `actor` over HTTP rather than as `local`.
 *
 * Principal TYPE alone is deliberately not enough. Production actor tokens are
 * minted only for the guardian principal, but a token is a bearer credential
 * that outlives the binding it was minted against: it stays signature-valid
 * until it expires, while the binding behind it can be revoked or rebound to a
 * different principal. Re-reading the binding per call is what makes a stale or
 * rebound token stop qualifying. It also excludes the service principals
 * (`svc_gateway`, `svc_daemon`) that share the same route policy but carry no
 * actor identity of their own, and it keeps the check correct if the set of
 * mint paths ever widens.
 *
 * Both transports derive the identity headers from verified auth and strip any
 * inbound copy, so neither can be spoofed by the caller.
 *
 * The auth-disabled bypass mirrors `requireBoundGuardian` and `enforcePolicy`:
 * when the daemon is not enforcing its own auth, it is sitting behind something
 * that is, and every gate in the process defers to that uniformly.
 */
export async function isOwnerCaller(
  headers?: Record<string, string>,
): Promise<boolean> {
  if (isHttpAuthDisabled()) {
    return true;
  }
  if (headers?.["x-vellum-principal-type"] === "local") {
    return true;
  }
  // Fresh: a deferred wake fires unattended and can recover guardian trust, so
  // a binding revoked or rebound minutes ago must stop qualifying immediately
  // rather than at the next cache expiry.
  return matchesBoundGuardian(headers?.["x-vellum-actor-principal-id"], {
    fresh: true,
  });
}
