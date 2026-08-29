/**
 * The identity every platform request is made under, read the two ways
 * consumers need it: imperatively for sequences that run outside React, and
 * reactively for components.
 *
 * `AppProviders` keys the request-scoped `QueryClient` on this string, so
 * anything that outlives a render and later writes into that cache (a redirect
 * return resolving across a full page load, say) can compare the scope it
 * started under against the scope in hand and drop a result the identity now
 * on screen never asked for.
 */
import { useAuthStore, useIsAuthenticated } from "@/stores/auth-store";
import {
  getActiveOrganizationIdForRequests,
  useRequestOrganizationId,
} from "@/stores/organization-store";
import { isAuthenticated } from "@/stores/session-status";
import { requestScopeKey } from "@/utils/request-scope-key";

/**
 * The scope a request made right now would carry.
 *
 * The organization comes from `getActiveOrganizationIdForRequests()`, the same
 * derivation that builds `Vellum-Organization-Id`, so the key names whoever
 * the server actually answered for. The store's resolved id alone would not:
 * it is null while the persisted id is carrying requests, which stamps an
 * organization's response as belonging to no organization at all.
 */
export function currentRequestScopeKey(): string {
  const { sessionStatus, user } = useAuthStore.getState();
  return requestScopeKey({
    isAuthenticated: isAuthenticated(sessionStatus),
    userId: user?.id,
    organizationId: getActiveOrganizationIdForRequests(),
  });
}

/** Subscribe to {@link currentRequestScopeKey}. */
export function useRequestScopeKey(): string {
  const authenticated = useIsAuthenticated();
  const user = useAuthStore.use.user();
  const organizationId = useRequestOrganizationId();
  return requestScopeKey({
    isAuthenticated: authenticated,
    userId: user?.id,
    organizationId,
  });
}
