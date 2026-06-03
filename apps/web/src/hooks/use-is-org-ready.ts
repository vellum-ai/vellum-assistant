import { useHasPlatformSession } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";

/**
 * Gate for queries that need the `Vellum-Organization-Id` header.
 * Returns `true` when the org store has hydrated, or when no
 * platform session exists (self-hosted / gateway-only auth).
 */
export function useIsOrgReady(): boolean {
  const currentOrgId = useOrganizationStore.use.currentOrganizationId();
  const hasPlatformSession = useHasPlatformSession();
  return !hasPlatformSession || currentOrgId != null;
}
