import { Suspense, useCallback, useEffect, useState } from "react";

import { useSearchParams, useNavigate } from "react-router";

import { useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellum/design-library/components/toast";
import { AdjustPlanModal } from "@/domains/settings/components/adjust-plan-modal.js";
import { BillingPanel } from "@/domains/settings/components/billing-panel.js";
import { BillingPortalReturnHandler } from "@/domains/settings/components/billing-portal-return-handler.js";
import { BillingUsagePanel } from "@/domains/settings/components/billing-usage/billing-usage-panel.js";
import { GracePeriodBanner } from "@/domains/settings/components/grace-period-banner.js";
import { MachineSizeCard } from "@/domains/settings/components/machine-size-card.js";
import { MachineSizeModal } from "@/domains/settings/components/machine-size-modal.js";
import { PaymentMethodsCard } from "@/domains/settings/components/payment-methods-card.js";
import { PlanCard } from "@/domains/settings/components/plan-card.js";
import { ReferralPanel } from "@/domains/settings/components/referral-panel.js";
import { StorageCard } from "@/domains/settings/components/storage-card.js";
import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import { useFeatureFlagStore } from "@/lib/feature-flags/feature-flag-store.js";
import { routes } from "@/utils/routes.js";

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
  const proPlanAdjust = useFeatureFlagStore.use.proPlanAdjust();
  const referralCodes = useFeatureFlagStore.use.referralCodes();
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const openPlanModal = useCallback(() => setPlanModalOpen(true), []);
  const closePlanModal = useCallback(() => setPlanModalOpen(false), []);

  const [machineModalOpen, setMachineModalOpen] = useState(false);
  const openMachineModal = useCallback(() => setMachineModalOpen(true), []);
  const closeMachineModal = useCallback(() => setMachineModalOpen(false), []);

  return (
    <div className="max-w-5xl space-y-4">
      <Suspense fallback={null}>
        <BillingStatusHandler />
        <BillingPortalReturnHandler />
      </Suspense>
      <GracePeriodBanner />
      {proPlanAdjust && (
        <>
          <PlanCard onManage={openPlanModal} />
          <AdjustPlanModal open={planModalOpen} onClose={closePlanModal} />
          <MachineSizeCard onManage={openMachineModal} />
          <MachineSizeModal
            open={machineModalOpen}
            onClose={closeMachineModal}
          />
          <StorageCard />
        </>
      )}
      <Suspense fallback={null}>
        <BillingPanel />
      </Suspense>
      <PaymentMethodsCard />
      <BillingUsagePanel />
      {referralCodes && <ReferralPanel />}
    </div>
  );
}
