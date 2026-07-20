import { useHasPlatformSession } from "@/stores/auth-store";
import {
  getActiveOrganizationIdForRequests,
  useOrganizationStore,
} from "@/stores/organization-store";

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
  // Subscribed for reactivity: the sessionStorage fallback only changes
  // through store actions, so store updates cover every readiness change.
  const currentOrgId = useOrganizationStore.use.currentOrganizationId();
  const hasPlatformSession = useHasPlatformSession();
  if (!hasPlatformSession) {
    return true;
  }
  return currentOrgId != null || getActiveOrganizationIdForRequests() != null;
}
