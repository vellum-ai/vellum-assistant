import { getDeviceBool } from "@/utils/device-settings";
import { useOnboardingStore } from "@/domains/onboarding/onboarding-store";

/**
 * Shared analytics-consent read for telemetry emitters.
 *
 * Analytics is opt-out: an absent preference (never asked) authorizes uploads;
 * only an explicit opt-out stops them. The persisted device bool
 * (`device:share_analytics`) and the in-memory `shareAnalytics` store flag must
 * BOTH agree — the AND — so a failed opt-out write cannot leave an older stored
 * opt-in authorizing a new event.
 *
 * This is the single consent decision every funnel gates on. It lives in
 * `lib/` (not a domain) so both the onboarding funnel and the intelligence
 * domain's Memory telemetry can route through the same check without a
 * cross-domain import (`local/no-cross-domain-imports`).
 */
export function readAnalyticsConsent(): boolean {
  return (
    useOnboardingStore.getState().shareAnalytics &&
    getDeviceBool("shareAnalytics", true)
  );
}
