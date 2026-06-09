import { useAuthStore, useHasPlatformSession } from "@/stores/auth-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { getElectronSessionToken } from "@/runtime/session-token";

/**
 * Gate for queries that need the `Vellum-Organization-Id` header.
 * Returns `true` when the org store has hydrated, or when no
 * platform session exists (self-hosted / gateway-only auth).
 */
export function useIsOrgReady(): boolean {
  const currentOrgId = useOrganizationStore.use.currentOrganizationId();
  const hasPlatformSession = useHasPlatformSession();
  const platformSession = useAuthStore.use.platformSession();
  const hasElectronSessionToken = getElectronSessionToken() != null;
  const waitingForElectronPlatformSession =
    platformSession === "unknown" && hasElectronSessionToken;
  return (
    (!hasPlatformSession && !waitingForElectronPlatformSession) ||
    currentOrgId != null
  );
}
