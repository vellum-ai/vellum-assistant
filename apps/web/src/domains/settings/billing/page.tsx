
import { Suspense, useCallback, useEffect, useState } from "react";

import { useAppRouting } from "@/adapters/app-routing.js";

import { useQueryClient } from "@tanstack/react-query";

import { toast } from "@vellum/design-library/components/toast";
import { AdjustPlanModal } from "@/components/app/settings/AdjustPlanModal.js";
import { BillingPanel } from "@/components/app/settings/BillingPanel.js";
import { BillingPortalReturnHandler } from "@/components/app/settings/BillingPortalReturnHandler.js";
import { BillingUsagePanel } from "@/components/app/settings/billing-usage/BillingUsagePanel.js";
import { GracePeriodBanner } from "@/components/app/settings/GracePeriodBanner.js";
import { PaymentMethodsCard } from "@/components/app/settings/PaymentMethodsCard.js";
import { PlanCard } from "@/components/app/settings/PlanCard.js";
import { ReferralPanel } from "@/components/app/settings/ReferralPanel.js";
import { organizationsBillingSummaryRetrieveOptions } from "@/generated/api/@tanstack/react-query.gen.js";
import { useAppFeatureFlags } from "@/lib/feature-flags/feature-flag-provider.js";
import { routes } from "@/lib/routes.js";

/**
 * Handles the `billing_status` query parameter that Stripe redirects back with
 * after checkout completes (success) or is cancelled.
 */
function BillingStatusHandler() {
  const { replace, searchParams } = useAppRouting();
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
    replace(routes.settings.billing);
  }, [searchParams, replace, queryClient]);

  return null;
}

export default function BillingSettingsPage() {
  const { proPlanAdjust, referralCodes } = useAppFeatureFlags();
  const [planModalOpen, setPlanModalOpen] = useState(false);
  const openPlanModal = useCallback(() => setPlanModalOpen(true), []);
  const closePlanModal = useCallback(() => setPlanModalOpen(false), []);

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
