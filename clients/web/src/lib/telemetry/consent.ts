import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

/**
 * Shared analytics-consent read for telemetry emitters.
 *
 * A local explicit opt-out always wins — its server write may still be in
 * flight (or have failed). Otherwise the platform-computed effective verdict
 * (`serverAnalyticsEffective`, adopted at sync) decides; before the first
 * sync with a server record the opt-out default applies (analytics is
 * opt-out, so never-asked authorizes uploads).
 *
 * This is the single consent decision every emitter gates on. It lives in
 * `lib/` (not a domain) so both the onboarding funnel and the intelligence
 * domain's Memory telemetry can route through the same check without a
 * cross-domain import (`local/no-cross-domain-imports`).
 */
export function readAnalyticsConsent(): boolean {
  const { shareAnalytics, serverAnalyticsEffective } =
    useOnboardingStore.getState();
  if (shareAnalytics === false) return false;
  return serverAnalyticsEffective ?? true;
}
