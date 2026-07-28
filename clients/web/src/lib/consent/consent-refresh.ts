/**
 * Re-fetch platform consent on visibility/focus + a long-interval backstop,
 * so a platform-side revoke is picked up without a fresh login. Adopts the
 * server-effective verdicts for both data-capture gates; diagnostics
 * additionally routes through {@link applyResolvedDiagnosticsConsent} — the
 * single direction-asymmetric chokepoint that writes the saved preference and
 * the effective Sentry gate. A failed/timed-out fetch is swallowed and leaves
 * all consent state unchanged (never flips a gate on or off).
 */
import { fetchConsent } from "@/domains/account/profile";
import { applyResolvedDiagnosticsConsent } from "@/lib/consent/diagnostics-consent";
import { useAuthStore } from "@/stores/auth-store";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";
import { resolveServerConsent } from "@/lib/consent/consent-persistence";

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
  // Capture the authenticated user BEFORE the await so we can detect a
  // logout/account-switch that races the in-flight fetch.
  const userIdBefore = useAuthStore.getState().user?.id;
  if (!userIdBefore) return;
  try {
    const consent = await fetchConsent();
    // The user may have logged out or switched accounts while the fetch was in
    // flight. Applying a stale response would re-enable reporting after logout
    // or overwrite the next user's setting, so discard it.
    if (useAuthStore.getState().user?.id !== userIdBefore) return;
    const resolved = resolveServerConsent(consent);
    // An empty server record is not authoritative: a platform-side revoke
    // always arrives as a real record (share_diagnostics=false). Leave state
    // unchanged, matching the failed-fetch posture; the auth resync owns the
    // no-record path.
    if (!resolved.hasServerRecord) return;
    const store = useOnboardingStore.getState();
    // Adopt both effective verdicts, mirroring the auth-store sync, so a
    // platform-side revoke closes the gates without a fresh login. The
    // pending opt-in clears only once the fetched record REFLECTS it — a
    // refresh racing the opt-in's in-flight PATCH must not flip uploads
    // back off on the stale record.
    if (resolved.shareAnalytics === true) {
      store.setPendingAnalyticsOptIn(false);
    }
    store.setServerAnalyticsEffective(resolved.analyticsEffective);
    store.setServerDiagnosticsEffective(resolved.diagnosticsEffective);
    applyResolvedDiagnosticsConsent(
      {
        shareDiagnostics: resolved.shareDiagnostics,
        diagnosticsEffective: resolved.diagnosticsEffective,
        hasServerRecord: resolved.hasServerRecord,
      },
      store.setShareDiagnostics,
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
