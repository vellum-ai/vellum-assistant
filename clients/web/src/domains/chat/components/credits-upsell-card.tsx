import { lazy, useState } from "react";

import { useNavigate } from "react-router";

import { LazyBoundary } from "@/components/lazy-boundary";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import { resolveCreditPaywallCta } from "@/domains/chat/utils/credit-paywall-cta";
import {
  isBillingCtaUpgradeArm,
  useBillingCtaExperimentArm,
} from "@/hooks/use-billing-cta-experiment";
import { useIsFreePlan } from "@/hooks/use-is-free-plan";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { routes } from "@/utils/routes";

// Lazy for the same reason as the `AddCreditsModal` mount in
// `active-chat-view.tsx`: the Stripe checkout modal stays out of the chat
// bundle until a CTA actually opens it.
const AddCreditsModal = lazy(() =>
  import("@/components/add-credits-modal").then((m) => ({
    default: m.AddCreditsModal,
  })),
);

const UPGRADE_COPY = {
  title: "You’re out of Free credits",
  subtitle: "Upgrade your plan to keep the conversation going.",
  ctaLabel: "View plans",
};

const ADD_CREDITS_COPY = {
  title: "You’re out of credits",
  subtitle: "Add credits to pick up where you left off.",
  ctaLabel: "Add credits",
};

/**
 * Friendly credits upsell card: a single-CTA credit wall built on
 * {@link BillingErrorBanner}, rendered in the transcript in place of a
 * persisted credits-exhausted provider-error row. Self-contained (it resolves
 * its own CTA mode and mounts its own {@link AddCreditsModal} instance), so it
 * can also be mounted outside the transcript with no transcript-specific props.
 */
export function CreditsUpsellCard() {
  const navigate = useNavigate();
  const [showAddCredits, setShowAddCredits] = useState(false);

  // Managed credits are platform-hosted billing, so the card follows the
  // platform-hosted gate (like `MaintenanceModeBanner` and the billing
  // settings tab): "full" renders the real CTA, "disabled" renders the login
  // treatment, "gated" renders nothing. The gate also keys the subscription
  // fetch inside `useIsFreePlan` — without a platform session `useIsOrgReady`
  // still reports ready, so an ungated fetch would fire unauthenticated.
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const billingCtaArm = useBillingCtaExperimentArm();
  const isFreePlan = useIsFreePlan(platformGate === "full");
  const mode = resolveCreditPaywallCta({
    isUpgradeArm: isBillingCtaUpgradeArm(billingCtaArm),
    isFreePlan,
  });
  const copy = mode === "upgrade" ? UPGRADE_COPY : ADD_CREDITS_COPY;

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
    <>
      <BillingErrorBanner
        ariaLabel={`${copy.title}. ${copy.subtitle}`}
        icon={<span className="text-lg opacity-80">💰</span>}
        title={copy.title}
        subtitle={copy.subtitle}
        ctaLabel={copy.ctaLabel}
        onAction={
          mode === "upgrade"
            ? () => void navigate(routes.plans)
            : () => setShowAddCredits(true)
        }
        detached={true}
      />
      {showAddCredits ? (
        <LazyBoundary>
          <AddCreditsModal
            open={showAddCredits}
            onOpenChange={setShowAddCredits}
          />
        </LazyBoundary>
      ) : null}
    </>
  );
}
