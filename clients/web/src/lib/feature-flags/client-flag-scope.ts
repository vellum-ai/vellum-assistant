/**
 * Ties the client feature-flag store's hydration to the identity its values
 * were evaluated for.
 *
 * The platform evaluates client flags against the signed-in user + org, or
 * against an anonymous context when there is no session — so the two answers
 * legitimately differ. The `/account/*` screens sync flags for anonymous
 * visitors, which means a pre-sign-in value is already in the store when the
 * authenticated app mounts. Left alone it reads as settled, and a surface that
 * redirects on a default-off flag bounces before the authenticated response
 * lands.
 *
 * The watcher runs outside React rather than from a layout effect. The store
 * writes that move the scope (session settle, login, org resolution) happen in
 * plain callbacks, so a subscription resets the flag store before React
 * re-renders — child route effects (which run ahead of any layout's) can no
 * longer read the previous identity's values as settled.
 */
import { useAuthStore } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { isAuthenticated } from "@/stores/session-status";
import { requestScopeKey } from "@/utils/request-scope-key";

/**
 * The identity client flags currently evaluate against. Built from the same
 * inputs as the request-scoped query cache's key, so the store and the cache
 * can never disagree about which identity a response belongs to.
 */
export function currentClientFlagScopeKey(): string {
  const { sessionStatus, user } = useAuthStore.getState();
  return requestScopeKey({
    isAuthenticated: isAuthenticated(sessionStatus),
    userId: user?.id,
    organizationId: useOrganizationStore.getState().currentOrganizationId,
  });
}

/** Call once at startup. Returns an unsubscribe for tests. */
export function setupClientFlagScopeSync(): () => void {
  const claimCurrentScope = () => {
    useClientFeatureFlagStore
      .getState()
      .beginScope(currentClientFlagScopeKey());
  };
  claimCurrentScope();
  const unsubscribeAuth = useAuthStore.subscribe(claimCurrentScope);
  const unsubscribeOrganization =
    useOrganizationStore.subscribe(claimCurrentScope);
  return () => {
    unsubscribeAuth();
    unsubscribeOrganization();
  };
}
