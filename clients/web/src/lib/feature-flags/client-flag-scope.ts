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
 * re-renders. A layout effect would lose the race: a child route's own redirect
 * effect runs ahead of its parent layout's, and would read the previous
 * identity's values as settled.
 */
import { useAuthStore } from "@/stores/auth-store";
import { useClientFeatureFlagStore } from "@/stores/client-feature-flag-store";
import { useOrganizationStore } from "@/stores/organization-store";
import { currentRequestScopeKey } from "@/stores/request-scope";

/**
 * The identity client flags currently evaluate against: the scope the request
 * that fetched them carried, so the key names whoever the server evaluated for.
 *
 * Agreement is enforced rather than assumed: values carry the scope they were
 * produced under, and the store drops any the scope in hand no longer answers.
 */
export function currentClientFlagScopeKey(): string {
  return currentRequestScopeKey();
}

/**
 * Call once at startup. Returns an unsubscribe for tests.
 *
 * The subscriptions carry no selector: the scope is a function of several
 * slices across both stores, and a selectorless subscriber runs on every write
 * to either — including `clearOrganization()` revoking a persisted id the
 * resolved id slice never held.
 */
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
