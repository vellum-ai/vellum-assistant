import { getDeviceSetting } from "@/utils/device-settings";
import { readConsentHydrated } from "@/domains/onboarding/prefs";
import { useAuthStore } from "@/stores/auth-store";
import { isConfirmedPlatformSession } from "@/stores/session-status";

/**
 * The composed diagnostics gate, shared by `sentry-control.ts` (which decides
 * init vs close) and `flavor-capacitor.ts` (whose `beforeSend` reads the live
 * gate). Factored out so the flavor reads the same source without importing
 * `sentry-control`, which imports the flavor — that would be a cycle.
 *
 * Grants only on a probe-confirmed live platform session AND the effective
 * diagnostics-reporting gate. Diagnostics is opt-out, so an absent device gate
 * (never written) reads as open — but only once consent state has hydrated:
 * some session-confirmation paths (e.g. the local/gateway probe) publish a
 * live session before any consent sync, and a fresh device must not upload
 * ahead of learning about a server-side explicit opt-out. Every
 * consent-resolution path writes the gate key, so the hydration guard only
 * governs the pre-first-sync window. See `sentry-control.ts` for the full
 * rationale.
 */
export function diagnosticsConsentGranted(): boolean {
  const { platformSession, platformSessionRestoredOffline } =
    useAuthStore.getState();
  if (
    !isConfirmedPlatformSession(platformSession, platformSessionRestoredOffline)
  ) {
    return false;
  }
  const stored = getDeviceSetting("diagnosticsReporting", "");
  if (stored !== "") return stored === "true";
  return readConsentHydrated();
}
