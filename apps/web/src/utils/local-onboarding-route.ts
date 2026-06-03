/**
 * Local-mode onboarding entry route, chosen once the platform-session
 * probe has settled.
 *
 * In local mode the platform session is discovered by a fire-and-forget probe
 * (`auth-store`'s `initSession`) that returns before `getSession()` resolves,
 * so `hasPlatformSession` reads `false` while the probe is still in flight.
 * That `false` is ambiguous — "no session" and "not known yet" look identical —
 * and reading it early sends a returning platform user to the new-user welcome
 * flow instead of the hosting picker. `platformSessionResolved` is the flag
 * that disambiguates them.
 *
 * Routing the decision through this single async helper means every caller
 * (auth middleware, post-retire navigation) inherits the wait-then-read
 * ordering and none can reintroduce the race by reading the bare flag.
 */
import { useAuthStore } from "@/stores/auth-store";
import { routes } from "@/utils/routes";
import { whenStoreState } from "@/utils/when-store-state";

/**
 * Upper bound on the probe wait. The platform-session probe resolves in well
 * under a second against a reachable backend; this only caps the wait if it
 * hangs, in which case we fall back to the welcome flow (the safe default for
 * an unconfirmed session) rather than blocking navigation indefinitely.
 */
const PLATFORM_SESSION_PROBE_TIMEOUT_MS = 5_000;

export async function resolveLocalOnboardingRoute(): Promise<string> {
  await whenStoreState(
    useAuthStore,
    (state) => state.platformSessionResolved,
    { timeoutMs: PLATFORM_SESSION_PROBE_TIMEOUT_MS },
  );
  return useAuthStore.getState().hasPlatformSession
    ? routes.onboarding.hosting
    : routes.onboarding.welcome;
}
