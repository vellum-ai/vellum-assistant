import { Loader2 } from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";

import { useNavigate, useSearchParams } from "react-router";

import { useQueryClient } from "@tanstack/react-query";

import { BillingOnboardingModal } from "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal";
import { AdjustPlanModal } from "@/domains/settings/components/adjust-plan-modal";
import { BillingPanel } from "@/domains/settings/components/billing-panel";
import { BillingPortalReturnHandler } from "@/domains/settings/components/billing-portal-return-handler";
import { BillingUsagePanel } from "@/domains/settings/components/billing-usage/billing-usage-panel";
import { GracePeriodBanner } from "@/domains/settings/components/grace-period-banner";
import { PaymentMethodsCard } from "@/domains/settings/components/payment-methods-card";
import { PlanCard } from "@/domains/settings/components/plan-card";
import { ReferralPanel } from "@/domains/settings/components/referral-panel";
import { TierUpgradeResizeModal } from "@/domains/settings/components/tier-upgrade-resize-modal";
import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen";
import {
    useActiveAssistantIsPlatformHosted,
    useActiveAssistantLifecycleIsLoading,
    usePlatformGate,
} from "@/hooks/use-platform-gate";
import { useHasPlatformSession } from "@/stores/auth-store";
import { routes } from "@/utils/routes";
import { Notice } from "@vellumai/design-library/components/notice";
import { toast } from "@vellumai/design-library/components/toast";

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
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const hasPlatformSession = useHasPlatformSession();
  const isPlatformHosted = useActiveAssistantIsPlatformHosted();
  const isLifecycleLoading = useActiveAssistantLifecycleIsLoading();

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

  if (!hasPlatformSession) {
    return (
      <div className="space-y-4">
        <Notice tone="info">
          Log in to the Vellum platform to manage billing and usage.
        </Notice>
      </div>
    );
  }

  if (isLifecycleLoading) {
    return (
      <div className="space-y-4">
        <div className="flex items-center gap-2 py-6 text-body-medium-lighter text-[var(--content-secondary)]">
          <Loader2 className="h-4 w-4 animate-spin" />
          Loading billing…
        </div>
      </div>
    );
  }

  const showPlanManagement = isPlatformHosted;

  if (!isPlatformHosted && platformGate !== "gated") {
    return (
      <div className="space-y-4">
        <Notice tone="warning">
          Billing isn&apos;t available for the current assistant state.
        </Notice>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <Suspense fallback={null}>
        <BillingStatusHandler />
        <BillingPortalReturnHandler />
      </Suspense>
      {showPlanManagement && <GracePeriodBanner />}
      {showPlanManagement && <PlanCard onManage={openPlanModal} />}
      {showPlanManagement && (
        <AdjustPlanModal open={planModalOpen} onClose={closePlanModal} onTierUpgraded={onTierUpgraded} />
      )}
      <PaymentMethodsCard />
      <Suspense fallback={null}>
        <BillingPanel />
      </Suspense>
      <ReferralPanel />
      <BillingUsagePanel />
      {showPlanManagement && (
        <BillingOnboardingModal open={hasSessionId} onClose={closeOnboarding} />
      )}
      {showPlanManagement && (
        <TierUpgradeResizeModal
          open={resizeModalOpen}
          onClose={() => setResizeModalOpen(false)}
        />
      )}
    </div>
  );
}
