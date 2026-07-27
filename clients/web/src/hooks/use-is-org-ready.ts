import { useHasPlatformSession } from "@/stores/auth-store";
import {
  getActiveOrganizationIdForRequests,
  useOrganizationStore,
} from "@/stores/organization-store";

/**
 * How close the `Vellum-Organization-Id` header source is to producing an id.
 *
 * - `"ready"` — a request can carry the header now: the hydrated store, its
 *   sessionStorage fallback, or no platform session at all (self-hosted /
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

export function useOrgHeaderReadiness(): OrgHeaderReadiness {
  // Reactivity: the sessionStorage fallback only changes through store
  // actions, but not every readiness-affecting action moves the id slice —
  // `clearOrganization()` while the fallback carried readiness is null → null.
  // The status slice changes on those transitions, so subscribe to both.
  const currentOrgId = useOrganizationStore.use.currentOrganizationId();
  const status = useOrganizationStore.use.status();
  const hasPlatformSession = useHasPlatformSession();
  if (!hasPlatformSession) {
    return "ready";
  }
  if (currentOrgId != null || getActiveOrganizationIdForRequests() != null) {
    return "ready";
  }
  return status === "error" ? "unavailable" : "resolving";
}

/**
 * Gate for queries that need the `Vellum-Organization-Id` header.
 *
 * Ready when the header source (`getActiveOrganizationIdForRequests()`)
 * can produce an id — the hydrated store or its sessionStorage fallback —
 * or when no platform session exists (self-hosted / gateway-only auth).
 * Matching the interceptor's own fallback means a failed org-list fetch
 * can't wedge gated queries when a previous session already knows the org.
 */
export function useIsOrgReady(): boolean {
  return useOrgHeaderReadiness() === "ready";
}
