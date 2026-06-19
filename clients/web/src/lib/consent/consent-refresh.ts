/**
 * Re-fetch platform diagnostics consent on visibility/focus + a long-interval
 * backstop, so a platform-side revoke is picked up without a fresh login.
 *
 * Everything routes through {@link applyResolvedDiagnosticsConsent} — the single
 * version-aware, direction-asymmetric chokepoint that writes the saved
 * preference, the effective Sentry gate, and the Electron main-process mirror.
 * A failed/timed-out fetch is swallowed and leaves all diagnostics state
 * unchanged (never flips the gate on or off).
 */
import { fetchConsent } from "@/domains/account/profile";
import { applyResolvedDiagnosticsConsent } from "@/lib/consent/diagnostics-consent";
import { useAuthStore } from "@/stores/auth-store";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { resolveServerConsent } from "@/utils/onboarding-cleanup";

// Skip a refresh that fires within this window of the last one, so rapid
// focus/visibility events coalesce to one fetch.
const MIN_REFRESH_INTERVAL_MS = 60_000;

// Backstop poll so a revoke is eventually adopted even on a window that never
// loses or regains focus.
const BACKSTOP_INTERVAL_MS = 30 * 60_000;

let lastRefreshAt = 0;

/**
 * When a user is authenticated, fetch the server consent and route it through
 * the diagnostics chokepoint. No-op when unauthenticated; a thrown fetch leaves
 * state unchanged.
 */
export async function refreshDiagnosticsConsent(): Promise<void> {
  if (!useAuthStore.getState().user) return;
  try {
    const resolved = resolveServerConsent(await fetchConsent());
    applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: resolved.shareDiagnostics,
        diagnosticsVersionCurrent: resolved.diagnosticsCurrent,
        hasServerRecord: resolved.hasServerRecord,
      },
      useOnboardingStore.getState().setShareDiagnostics,
    );
  } catch {
    // Fetch failed/timed out — leave diagnostics state untouched.
  }
}

function refreshIfDue(): void {
  const now = Date.now();
  if (now - lastRefreshAt < MIN_REFRESH_INTERVAL_MS) return;
  lastRefreshAt = now;
  void refreshDiagnosticsConsent();
}

/**
 * Install visibility/focus refresh triggers plus the long-interval backstop.
 * Safe to call once at startup — the triggers re-check auth at fire time, so
 * this is a no-op while unauthenticated. Returns a cleanup that removes both
 * listeners and clears the timer. Guards DOM access for SSR/no-window.
 */
export function installConsentRefreshListeners(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") {
    return () => {};
  }

  const onVisibility = (): void => {
    if (document.visibilityState === "visible") refreshIfDue();
  };
  const onFocus = (): void => refreshIfDue();

  document.addEventListener("visibilitychange", onVisibility);
  window.addEventListener("focus", onFocus);
  const timer = setInterval(refreshIfDue, BACKSTOP_INTERVAL_MS);

  return () => {
    document.removeEventListener("visibilitychange", onVisibility);
    window.removeEventListener("focus", onFocus);
    clearInterval(timer);
  };
}
