/**
 * Local-mode onboarding entry route, chosen once the platform-session
 * probe has settled.
 *
 * In local mode the platform session is discovered by a fire-and-forget probe
 * (`auth-store`'s `initSession`) that returns before `getSession()` resolves,
 * so the status sits at `"unknown"` while the probe is still in flight.
 * Reading it early — treating the pre-settle window as "no session" — sends a
 * returning platform user to the new-user welcome flow instead of the hosting
 * picker. Waiting for the status to leave `"unknown"` disambiguates them.
 *
 * Routing the decision through this single async helper means every caller
 * (auth middleware, post-retire navigation) inherits the wait-then-read
 * ordering and none can reintroduce the race by reading the status early.
 */
import { useAuthStore } from "@/stores/auth-store";
import { hasLivePlatformSession } from "@/stores/session-status";
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
    (state) => state.platformSession !== "unknown",
    { timeoutMs: PLATFORM_SESSION_PROBE_TIMEOUT_MS },
  );
  return hasLivePlatformSession(useAuthStore.getState().platformSession)
    ? routes.onboarding.hosting
    : routes.onboarding.welcome;
}
