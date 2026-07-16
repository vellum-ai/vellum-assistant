import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

/**
 * Shared analytics-consent read for telemetry emitters.
 *
 * Analytics is opt-out: never-asked (`null`) authorizes uploads; only an
 * explicit opt-out stops them. The onboarding store is the single in-memory
 * source — hydrated from the `device:share_analytics` key at init and from
 * the server on sync — so an explicit opt-out stops uploads even if its
 * server write failed.
 *
 * This is the single consent decision every emitter gates on. It lives in
 * `lib/` (not a domain) so both the onboarding funnel and the intelligence
 * domain's Memory telemetry can route through the same check without a
 * cross-domain import (`local/no-cross-domain-imports`).
 */
export function readAnalyticsConsent(): boolean {
  return useOnboardingStore.getState().shareAnalytics !== false;
}
