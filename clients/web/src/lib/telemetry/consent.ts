import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

/**
 * Shared analytics-consent read for telemetry emitters.
 *
 * Privacy-asymmetric precedence:
 *   1. An explicit `false` anywhere locally always disables — an opt-out's
 *      server write may still be in flight (or have failed).
 *   2. A PENDING local opt-in (`pendingAnalyticsOptIn`, set by an explicit
 *      user opt-in, cleared when a sync reflects it) enables immediately —
 *      but a server-ADOPTED raw `true` earns no such override, so a
 *      divergent server-effective opt-out is never bypassed by adopted
 *      values.
 *   3. Otherwise the platform-computed effective verdict
 *      (`serverAnalyticsEffective`, adopted at sync) decides; before the
 *      first sync with a server record the opt-out default applies
 *      (analytics is opt-out, so never-asked authorizes uploads).
 *
 * This is the single consent decision every emitter gates on. It lives in
 * `lib/` (not a domain) so both the onboarding funnel and the intelligence
 * domain's Memory telemetry can route through the same check without a
 * cross-domain import (`local/no-cross-domain-imports`).
 */
export function readAnalyticsConsent(): boolean {
  const { shareAnalytics, serverAnalyticsEffective, pendingAnalyticsOptIn } =
    useOnboardingStore.getState();
  if (shareAnalytics === false) return false;
  if (pendingAnalyticsOptIn) return true;
  return serverAnalyticsEffective ?? true;
}
