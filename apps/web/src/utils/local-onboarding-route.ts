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
 * Re-probes (app-resume, return from a provider callback) deliberately keep the
 * last `"present"`/`"absent"` rather than reopening `"unknown"`, so reactive
 * consumers don't flicker — which means the displayed status can be a prior
 * result while a fresh probe is still in flight. This one-shot fork must read
 * the current session, so it also waits on the probe's settle promise, not just
 * for the status to leave `"unknown"`.
 *
 * Routing the decision through this single async helper means every caller
 * (auth middleware, post-retire navigation) inherits the wait-then-read
 * ordering and none can reintroduce the race by reading the status early.
 */
import {
  useAuthStore,
  whenPlatformSessionSettled,
} from "@/stores/auth-store";
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

/** Resolve when the in-flight probe settles, or when `timeoutMs` elapses. */
function awaitProbeSettle(timeoutMs: number): Promise<void> {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, timeoutMs);
    void whenPlatformSessionSettled().finally(() => {
      clearTimeout(timer);
      resolve();
    });
  });
}

export async function resolveLocalOnboardingRoute(): Promise<string> {
  const deadline = Date.now() + PLATFORM_SESSION_PROBE_TIMEOUT_MS;
  // The boot probe starts at "unknown"; wait for it to settle before reading,
  // so the pre-settle window isn't collapsed into "no session".
  await whenStoreState(
    useAuthStore,
    (state) => state.platformSession !== "unknown",
    { timeoutMs: PLATFORM_SESSION_PROBE_TIMEOUT_MS },
  );
  // A re-probe may still be in flight while the status shows a prior
  // "present"/"absent"; wait it out too (under the same upper bound) so the
  // fork reads the fresh result rather than a stale one.
  await awaitProbeSettle(Math.max(0, deadline - Date.now()));
  return hasLivePlatformSession(useAuthStore.getState().platformSession)
    ? routes.onboarding.hosting
    : routes.onboarding.welcome;
}
