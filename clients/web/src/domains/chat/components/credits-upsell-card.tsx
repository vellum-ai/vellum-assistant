import { lazy, Suspense, useState } from "react";

import { useNavigate } from "react-router";

import { BillingErrorBanner } from "@/domains/chat/components/billing-error-banner";
import {
  resolveCreditPaywallCta,
  type CreditPaywallCtaMode,
} from "@/domains/chat/utils/credit-paywall-cta";
import {
  isBillingCtaUpgradeArm,
  useBillingCtaExperimentArm,
} from "@/hooks/use-billing-cta-experiment";
import { useIsFreePlan } from "@/hooks/use-is-free-plan";
import { routes } from "@/utils/routes";

// Lazy for the same reason as the composer-banner mount in
// `active-chat-view.tsx`: the Stripe checkout modal stays out of the chat
// bundle until a CTA actually opens it.
const AddCreditsModal = lazy(() =>
  import("@/components/add-credits-modal").then((m) => ({
    default: m.AddCreditsModal,
  })),
);

// Both add-credits modes share one copy set; the free/paid split only matters
// for the harder-sell composer banner this card's wording deliberately softens.
const ADD_CREDITS_COPY = {
  title: "You’re out of credits",
  subtitle: "Add credits to pick up where you left off.",
  ctaLabel: "Add credits",
};

const COPY: Record<
  CreditPaywallCtaMode,
  { title: string; subtitle: string; ctaLabel: string }
> = {
  upgrade: {
    title: "You’re out of Free credits",
    subtitle: "Upgrade your plan to keep the conversation going.",
    ctaLabel: "View plans",
  },
  "add-credits-free": ADD_CREDITS_COPY,
  "add-credits-paid": ADD_CREDITS_COPY,
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

  const billingCtaArm = useBillingCtaExperimentArm();
  const isFreePlan = useIsFreePlan(true);
  const mode = resolveCreditPaywallCta({
    isUpgradeArm: isBillingCtaUpgradeArm(billingCtaArm),
    isFreePlan,
  });
  const copy = COPY[mode];

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
        <Suspense fallback={null}>
          <AddCreditsModal
            open={showAddCredits}
            onOpenChange={setShowAddCredits}
          />
        </Suspense>
      ) : null}
    </>
  );
}
