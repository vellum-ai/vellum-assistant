import { Loader2 } from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";

import { useNavigate, useSearchParams } from "react-router";

import { useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { BillingOnboardingModal } from "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal";
import { UsageTab } from "@/domains/settings/billing/usage/usage-tab";
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
import { routes } from "@/utils/routes";
import { Notice } from "@vellumai/design-library/components/notice";
import { Tabs } from "@vellumai/design-library/components/tabs";
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
    if (!billingStatus) {
      return;
    }

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

/**
 * The plan/credits/payment management view. Platform-gated: billing only has
 * meaning for a Vellum-hosted assistant with a platform session.
 */
function BillingTab() {
  const platformGate = usePlatformGate({ platformHostedOnly: true });
  const billingGate = usePlatformGate();
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

  if (billingGate === "disabled") {
    return (
      <div className="space-y-4">
        <PlatformLoginNotice>
          Log in to the Vellum platform to manage billing and usage.
        </PlatformLoginNotice>
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

function UsagePanel() {
  const assistantId = useActiveAssistantId();
  // The credit-usage chart reads the organization-scoped platform billing API,
  // so it only makes sense for a platform-hosted assistant with the platform
  // API reachable. This tab always renders (the daemon breakdown below works
  // for every assistant), so gate the chart the same way the Billing tab gates
  // its platform content: the platform-hosted-only gate must be "full", and the
  // default reachability gate must not be "gated". The reachability gate is
  // required because `platformHostedOnly` ignores VELLUM_DISABLE_PLATFORM — in
  // local mode with the platform API disabled it can still report "full" even
  // though `platformFeaturesGate` aborts the request, which the Billing tab
  // already avoids by hiding itself for that same gated state.
  // `useBillingUsageData` applies the same two-gate check to its fetches, so no
  // billing request fires when the chart is hidden. The daemon breakdown table
  // renders for every assistant regardless.
  const chartGate = usePlatformGate({ platformHostedOnly: true });
  const reachabilityGate = usePlatformGate();
  const showChart = chartGate === "full" && reachabilityGate !== "gated";

  return (
    <div className="space-y-4">
      {showChart && <BillingUsagePanel />}
      <UsageTab assistantId={assistantId} />
    </div>
  );
}

export function BillingPage() {
  // Usage reads from the local daemon and works for every assistant, so it is
  // never gated. Billing only has meaning when the platform API is reachable —
  // when it is gated (local mode with the platform API disabled), hide the
  // Billing tab entirely and let Usage stand alone.
  const billingGate = usePlatformGate();
  const showBillingTab = billingGate !== "gated";

  const [searchParams, setSearchParams] = useSearchParams();
  const activeTab =
    !showBillingTab || searchParams.get("tab") === "usage" ? "usage" : "billing";

  const handleTabChange = (value: string) => {
    const next = new URLSearchParams(searchParams);
    if (value === "usage") {
      next.set("tab", "usage");
    } else {
      next.delete("tab");
    }
    setSearchParams(next, { replace: true });
  };

  return (
    <div className="space-y-6">
      <Tabs.Root value={activeTab} onValueChange={handleTabChange}>
        <Tabs.List>
          {showBillingTab && <Tabs.Trigger value="billing">Billing</Tabs.Trigger>}
          <Tabs.Trigger value="usage">Usage</Tabs.Trigger>
        </Tabs.List>
        {showBillingTab && (
          <Tabs.Panel value="billing" className="pt-4">
            <BillingTab />
          </Tabs.Panel>
        )}
        <Tabs.Panel value="usage" className="pt-4">
          <UsagePanel />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}
