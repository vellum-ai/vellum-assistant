import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import {
  getActiveOrganizationIdForRequests,
  useOrganizationStore,
  useRequestOrganizationId,
  type OrganizationStatus,
} from "@/stores/organization-store";
import { hasLivePlatformSession } from "@/stores/session-status";

/**
 * How close the `Vellum-Organization-Id` header source is to producing an id.
 *
 * - `"ready"` — a request can carry the header now: the hydrated store, its
 *   persisted organization id, or no platform session at all (self-hosted /
 *   gateway-only auth, where the interceptor uses bearer auth instead).
 * - `"resolving"` — the org list is still on its way. Transient by
 *   construction: every exit path of `fetchOrganizations()` lands on `"ready"`
 *   or `"error"`.
 * - `"unavailable"` — org resolution concluded and produced no usable id (the
 *   fetch failed, or the account has no organization). Requests that need the
 *   header cannot succeed until something re-triggers the fetch, so callers
 *   that would otherwise wait indefinitely can stop waiting here.
 *
 * The three-way answer exists because "not ready" conflates two opposite
 * situations for a caller deciding whether to keep waiting: an id that hasn't
 * arrived *yet* and an id that is never arriving.
 */
export type OrgHeaderReadiness = "ready" | "resolving" | "unavailable";

/**
 * How long an imperative caller gives `"resolving"` to settle before treating
 * the header source as unavailable. Matches the auth middleware's hydration
 * ceiling: org resolution is a single round trip, so waiting longer only
 * postpones the retry the user has to take anyway.
 */
export const ORG_HEADER_SETTLE_TIMEOUT_MS = 5_000;

function resolveOrgHeaderReadiness(
  requestOrganizationId: string | null,
  status: OrganizationStatus,
  hasPlatformSession: boolean,
): OrgHeaderReadiness {
  if (!hasPlatformSession) {
    return "ready";
  }
  if (requestOrganizationId != null) {
    return "ready";
  }
  return status === "error" ? "unavailable" : "resolving";
}

export function useOrgHeaderReadiness(): OrgHeaderReadiness {
  return resolveOrgHeaderReadiness(
    useRequestOrganizationId(),
    useOrganizationStore.use.status(),
    useHasPlatformSession(),
  );
}

/**
 * Imperative read of {@link useOrgHeaderReadiness}, for async sequences outside
 * the render cycle that must not fire a header-less platform request while the
 * org store is still hydrating. Same derivation the hook and the interceptor
 * share, so a gate built on it moves with the header rather than trailing it.
 */
export function getOrgHeaderReadiness(): OrgHeaderReadiness {
  return resolveOrgHeaderReadiness(
    getActiveOrganizationIdForRequests(),
    useOrganizationStore.getState().status,
    hasLivePlatformSession(useAuthStore.getState().platformSession),
  );
}

/**
 * Gate for queries that need the `Vellum-Organization-Id` header.
 *
 * Ready when the header source can produce an id — the hydrated store or its
 * persisted organization id — or when no platform session exists (self-hosted
 * / gateway-only auth). Reading the same derivation the interceptor does means
 * a failed org-list fetch can't wedge gated queries when a previous session
 * already knows the org.
 */
export function useIsOrgReady(): boolean {
  return useOrgHeaderReadiness() === "ready";
}
