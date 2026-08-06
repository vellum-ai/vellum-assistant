import { useNavigate } from "react-router";

import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import {
  isBillingCtaUpgradeArm,
  useBillingCtaExperimentArm,
} from "@/hooks/use-billing-cta-experiment";
import { useIsFreePlan } from "@/hooks/use-is-free-plan";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { ANDROID_BILLING_MESSAGE } from "@/lib/billing/android-consumption-only";
import { useIsNativeAndroid } from "@/runtime/platform-detection";
import { useAddCreditsModalStore } from "@/stores/add-credits-modal-store";
import { routes } from "@/utils/routes";

/** Free-plan copy in the `upgrade-cta` experiment arm. */
export const UPGRADE_COPY = {
  title: "You’re out of Free credits",
  subtitle: "Upgrade your plan to keep the conversation going.",
  ctaLabel: "View plans",
};

/** The default credit-wall copy: control arm, or any paid plan. */
export const ADD_CREDITS_COPY = {
  title: "You’re out of credits",
  subtitle: "Add credits to pick up where you left off.",
  ctaLabel: "Add credits",
};

/**
 * Friendly credits upsell card: a single-CTA credit wall built on
 * {@link BillingErrorBanner}, rendered in the transcript in place of a
 * persisted credits-exhausted provider-error row. Takes no
 * transcript-specific props and resolves its own CTA mode, so it works
 * anywhere under `ActiveChatView`, where the shared `LazyAddCreditsModal` the
 * Add Credits CTA opens (via {@link useAddCreditsModalStore}) is mounted; a
 * mount outside that tree would have a dead Add Credits CTA.
 */
export function CreditsUpsellCard() {
  const navigate = useNavigate();

  // Managed credits are platform-hosted billing, so the card follows the
  // platform-hosted gate (like `MaintenanceModeBanner` and the billing
  // settings tab): "full" renders the real CTA, "disabled" renders the login
  // treatment, "gated" renders nothing. The gate also keys the subscription
  // fetch inside `useIsFreePlan`: without a platform session `useIsOrgReady`
  // still reports ready, so an ungated fetch would fire unauthenticated.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const billingCtaArm = useBillingCtaExperimentArm();
  const isFreePlan = useIsFreePlan(platformGate === "full");
  // Upgrade CTA shows ONLY in the experiment upgrade arm AND for a free-plan
  // org; an unknown/unresolved plan / unhydrated flags count as paid.
  const isUpgrade =
    isBillingCtaUpgradeArm(billingCtaArm) && isFreePlan === true;
  const copy = isUpgrade ? UPGRADE_COPY : ADD_CREDITS_COPY;

  // Native Android is consumption-only: purchase entry points (add credits,
  // view plans) are hidden and the subtitle points at the website instead.
  const isNativeAndroid = useIsNativeAndroid();
  const subtitle = isNativeAndroid ? ANDROID_BILLING_MESSAGE : copy.subtitle;

  if (platformGate === "gated") {
    // Self-hosted active assistant: every recovery action the card could
    // offer targets the platform, so there is nothing useful to render.
    // Defensive rail: every mount point (transcript substitution, proactive
    // tail, empty state) keys off `useBillingBalanceStatus().isExhausted`,
    // which stays false without a platform billing read, so gated contexts
    // never mount the card through a normal path.
    return null;
  }

  if (platformGate === "disabled") {
    // Platform reachable but no platform session (e.g. it expired): the
    // add-credits / view-plans CTAs cannot complete a billing request, so
    // offer the shared login affordance instead of a dead-end CTA.
    return (
      <PlatformLoginNotice className="mx-auto max-w-[calc(100%-24px)]">
        Log in to the Vellum platform to add credits.
      </PlatformLoginNotice>
    );
  }

  return (
    <BillingErrorBanner
      ariaLabel={`${copy.title}. ${subtitle}`}
      icon={<span className="text-lg opacity-80">💰</span>}
      title={copy.title}
      subtitle={subtitle}
      action={
        isNativeAndroid
          ? undefined
          : {
              label: copy.ctaLabel,
              onClick: isUpgrade
                ? () => void navigate(routes.plans)
                : () => useAddCreditsModalStore.getState().setOpen(true),
            }
      }
      detached={true}
    />
  );
}
