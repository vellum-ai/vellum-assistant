import { isLocalMode } from "@/lib/local-mode";
import { useAuthStore } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";

/**
 * Gate for queries that need the `Vellum-Organization-Id` header.
 * Returns `true` when the org store has hydrated, or when the header
 * isn't needed (local mode, no platform session).
 */
export function useIsOrgReady(): boolean {
  const currentOrgId = useOrganizationStore.use.currentOrganizationId();
  const hasPlatformSession = useAuthStore.use.hasPlatformSession();
  return isLocalMode() || !hasPlatformSession || currentOrgId != null;
}
