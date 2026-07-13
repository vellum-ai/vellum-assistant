import { getDeviceBool } from "@/utils/device-settings";
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
 * (never resolved) reads as open — only an explicit opt-out closes it. See
 * `sentry-control.ts` for the full rationale.
 */
export function diagnosticsConsentGranted(): boolean {
  const { platformSession, platformSessionRestoredOffline } =
    useAuthStore.getState();
  if (
    !isConfirmedPlatformSession(platformSession, platformSessionRestoredOffline)
  ) {
    return false;
  }
  return getDeviceBool("diagnosticsReporting", true);
}
