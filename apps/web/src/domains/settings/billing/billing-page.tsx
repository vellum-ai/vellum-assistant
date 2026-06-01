import { Suspense, useCallback, useEffect, useState } from "react";

import { Navigate, useSearchParams, useNavigate } from "react-router";

import { useQueryClient } from "@tanstack/react-query";

import { Notice } from "@vellum/design-library/components/notice";
import { toast } from "@vellum/design-library/components/toast";
import { usePlatformGate } from "@/hooks/use-platform-gate";
import { BillingOnboardingModal } from "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal";
import { AdjustPlanModal } from "@/domains/settings/components/adjust-plan-modal";
import { BillingPanel } from "@/domains/settings/components/billing-panel";
import { BillingPortalReturnHandler } from "@/domains/settings/components/billing-portal-return-handler";
import { BillingUsagePanel } from "@/domains/settings/components/billing-usage/billing-usage-panel";
import { GracePeriodBanner } from "@/domains/settings/components/grace-period-banner";
import { PaymentMethodsCard } from "@/domains/settings/components/payment-methods-card";
import { PlanCard } from "@/domains/settings/components/plan-card";
import { TierUpgradeResizeModal } from "@/domains/settings/components/tier-upgrade-resize-modal";
import { ReferralPanel } from "@/domains/settings/components/referral-panel";
import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import { routes } from "@/utils/routes";

/**
 * Handles the `billing_status` query parameter that Stripe redirects back with
 * after checkout completes (success) or is cancelled.
 */
function BillingStatusHandler() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  useEffect(() => {
    const billingStatus = searchParams.get("billing_status");
    if (!billingStatus) return;

    if (billingStatus === "success") {
      toast.success("Payment received! Your credit balance will update shortly.", {
        id: "billing-status",
      });
      queryClient.invalidateQueries({
        queryKey: organizationsBillingSummaryRetrieveOptions().queryKey,
      });
    } else if (billingStatus === "cancel") {
      toast.info("Checkout was cancelled. No credits were added.", {
        id: "billing-status",
      });
    }

    // Clean up billing params from the URL.
    navigate(routes.settings.billing, { replace: true });
  }, [searchParams, navigate, queryClient]);

  return null;
}

export function BillingPage() {
  // Billing is fully platform-routed — plan management, payment methods,
  // credit balance, referrals, and usage all live behind organization-scoped
  // APIs that have no meaningful target on a self-hosted assistant. Use
  // `platformHostedOnly` so the gate flips to `"gated"` in any self-hosted
  // state (lifecycle `kind: "self_hosted"` or `kind: "active"` + `isLocal:
  // true`) regardless of platform session, and to `"disabled"` when there's
  // no platform session at all.
  const platformGate = usePlatformGate({ platformHostedOnly: true });

  const [searchParams, setSearchParams] = useSearchParams();
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const openPlanModal = useCallback(() => setPlanModalOpen(true), []);
  const closePlanModal = useCallback(() => setPlanModalOpen(false), []);
  const [resizeModalOpen, setResizeModalOpen] = useState(false);
  const onTierUpgraded = useCallback(() => setResizeModalOpen(true), []);

  useEffect(() => {
    if (searchParams.has("adjust_plan")) {
      setPlanModalOpen(true);
      setSearchParams((prev) => {
        const next = new URLSearchParams(prev);
        next.delete("adjust_plan");
        return next;
      }, { replace: true });
    }
  }, [searchParams, setSearchParams]);

  const hasSessionId = searchParams.has("session_id");
  const closeOnboarding = useCallback(() => {
    setSearchParams((prev) => {
      const next = new URLSearchParams(prev);
      next.delete("session_id");
      return next;
    }, { replace: true });
  }, [setSearchParams]);

  // Whole-page gate: bookmarks/shared-links to /settings/billing on a
  // self-hosted assistant should land somewhere sensible rather than render
  // nothing. Sidebar entry is also filtered out in `settings-layout.tsx` as
  // defense in depth for in-app navigation.
  if (platformGate === "gated") {
    return <Navigate replace to={routes.settings.general} />;
  }

  // Logged-out (no platform session, not self-hosted) renders the page
  // chrome with a login notice — better UX than redirecting to general.
  if (platformGate === "disabled") {
    return (
      <div className="max-w-5xl space-y-4">
        <Notice tone="info">
          Log in to the Vellum platform to manage billing and usage.
        </Notice>
      </div>
    );
  }

  return (
    <div className="max-w-5xl space-y-4">
      <Suspense fallback={null}>
        <BillingStatusHandler />
        <BillingPortalReturnHandler />
      </Suspense>
      <GracePeriodBanner />
      <PlanCard onManage={openPlanModal} />
      <AdjustPlanModal open={planModalOpen} onClose={closePlanModal} onTierUpgraded={onTierUpgraded} />
      <PaymentMethodsCard />
      <Suspense fallback={null}>
        <BillingPanel />
      </Suspense>
      <ReferralPanel />
      <BillingUsagePanel />
      <BillingOnboardingModal open={hasSessionId} onClose={closeOnboarding} />
      <TierUpgradeResizeModal
        open={resizeModalOpen}
        onClose={() => setResizeModalOpen(false)}
      />
    </div>
  );
}
