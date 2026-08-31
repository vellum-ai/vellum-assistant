import { useCallback, useEffect, useState } from "react";

import { useLocation, useNavigate, useSearchParams } from "react-router";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { BillingOnboardingModal } from "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal";
import { shouldShowBillingTab } from "@/domains/settings/billing/billing-tab-visibility";
import { CheckoutBonusModal } from "@/domains/settings/billing/checkout-bonus-modal";
import { useCheckoutBonusOffer } from "@/domains/settings/billing/use-checkout-bonus-offer";
import { proPackageDisplayName } from "@/domains/settings/billing/package-types";
import { UsageTab } from "@/domains/settings/billing/usage/usage-tab";
import { AdjustPlanModal } from "@/domains/settings/components/adjust-plan-modal";
import { BillingPanel } from "@/domains/settings/components/billing-panel";
import { BillingPortalReturnHandler } from "@/domains/settings/components/billing-portal-return-handler";
import { BillingUsagePanel } from "@/domains/settings/components/billing-usage/billing-usage-panel";
import { GracePeriodBanner } from "@/domains/settings/components/grace-period-banner";
import { InvoicesTable } from "@/domains/settings/components/invoices-table";
import { PaymentMethodsCard } from "@/domains/settings/components/payment-methods-card";
import { PlanCard } from "@/domains/settings/components/plan-card";
import { SkeletonCardBlock } from "@/domains/settings/components/skeleton-card-block";
import { useSetupIntentReturn } from "@/domains/settings/hooks/use-setup-intent-return";
import { replaceSearchParams } from "@/domains/settings/utils/replace-search-params";
import { useAssistantDomains } from "@/domains/settings/billing/pro-onboarding/use-assistant-domains";
import {
  organizationsBillingSubscriptionOnboardingRetrieveOptions,
  organizationsBillingSubscriptionRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import { useIsOrgReady } from "@/hooks/use-is-org-ready";
import { notifyCheckoutSuccess } from "@/lib/billing/checkout-success";
import { useTranslation } from "@/i18n";
import {
  useActiveAssistantIsPlatformHosted,
  useActiveAssistantLifecycleIsLoading,
  usePlatformGate,
  usePlatformGateWithPending,
} from "@/hooks/use-platform-gate";
import { useIsPlatformSessionSettled } from "@/stores/auth-store";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
import { Notice } from "@vellumai/design-library/components/notice";
import { Skeleton } from "@vellumai/design-library/components/skeleton";
import { Tabs } from "@vellumai/design-library/components/tabs";
import { toast } from "@vellumai/design-library/components/toast";

/**
 * Handles the `billing_status` query parameter that Stripe redirects back with
 * after checkout completes (success) or is cancelled. The upgrade-cancel page
 * funnels into the cancel branch too, tagged `billing_context=upgrade` so the
 * toast keeps its copy. A cancel is also lifted into parent state via
 * `onCheckoutCancelled` before the navigate below wipes the query string, so
 * the abandoned-checkout bonus offer can run its server-side eligibility
 * check.
 */
function BillingStatusHandler({
  onCheckoutCancelled,
}: {
  onCheckoutCancelled: () => void;
}) {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { t } = useTranslation("settings");

  useEffect(() => {
    const billingStatus = searchParams.get("billing_status");
    if (!billingStatus) {
      return;
    }

    if (billingStatus === "success") {
      notifyCheckoutSuccess(queryClient);
    } else if (billingStatus === "cancel") {
      toast.info(
        searchParams.get("billing_context") === "upgrade"
          ? t("billingStatusHandler.upgradeCancelToast")
          : t("billingStatusHandler.topUpCancelToast"),
        { id: "billing-status" },
      );
      onCheckoutCancelled();
    }

    navigate(routes.settings.usageBilling, { replace: true });
  }, [searchParams, navigate, queryClient, onCheckoutCancelled, t]);

  return null;
}

/**
 * Re-entry nudge into the pro onboarding wizard: shown while the org is on Pro
 * with domain setup offered but no assistant email domain registered yet.
 */
function FinishProSetupNotice({
  onFinishSetup,
}: {
  onFinishSetup: () => void;
}) {
  const { t } = useTranslation("settings");
  // Gate the query chain on org readiness (and subscribe to it, so the notice
  // re-evaluates when the org hydrates): a request fired before the org store
  // settles omits `Vellum-Organization-Id` and the platform rejects it.
  const orgReady = useIsOrgReady();
  const { data: subscription } = useQuery({
    ...organizationsBillingSubscriptionRetrieveOptions(),
    enabled: orgReady,
  });
  const isPro = subscription?.plan_id === "pro";
  const { data: onboarding } = useQuery({
    ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
    enabled: isPro && orgReady,
  });
  // `domain_setup_available` only says the platform offers domain setup — it
  // stays true after a domain is registered, so the real "still unconfigured"
  // signal is the assistant's domains list being loaded and empty.
  const domainSetupOffered =
    isPro && onboarding?.domain_setup_available === true;
  const { domains } = useAssistantDomains(
    domainSetupOffered,
    onboarding?.primary_assistant_id,
  );
  const domainMissing = domains !== undefined && domains.results.length === 0;

  if (!domainSetupOffered || !domainMissing) {
    return null;
  }

  return (
    <Notice
      tone="info"
      title={t("billingPage.finishSetupTitle", {
        plan: proPackageDisplayName(subscription?.package),
      })}
      actions={
        <Button
          variant="outlined"
          size="compact"
          onClick={onFinishSetup}
          data-testid="finish-pro-setup-button"
        >
          {t("billingPage.finishSetupButton")}
        </Button>
      }
      data-testid="finish-pro-setup-notice"
    >
      {t("billingPage.finishSetupBody")}
    </Notice>
  );
}

/**
 * Stand-in for the whole Billing tab while it cannot render yet: three blocks
 * for the plan, payment-method, and credits cards, so the swap to real content
 * does not jump. Only the stack is labeled, so a screen reader hears one
 * announcement rather than one per block.
 */
function BillingTabSkeleton() {
  const { t } = useTranslation("settings");
  return (
    <div
      role="status"
      aria-label={t("billingPage.loadingBillingAriaLabel")}
      className="space-y-4"
      data-testid="billing-tab-skeleton"
    >
      <SkeletonCardBlock />
      <SkeletonCardBlock />
      <SkeletonCardBlock />
    </div>
  );
}

/**
 * Stand-in for the whole page while the platform-session probe is still
 * pending. It reuses the settled render's wrappers exactly: the `space-y-6`
 * shell, a `Tabs.List` built from the real trigger parts so the bar's height
 * matches to the pixel, and the panel's `pt-4` around the card stack. Settling
 * therefore swaps content in place instead of mounting chrome above the cards.
 *
 * The triggers stand in for labels the probe has not decided on yet, so they
 * are disabled and hidden from the accessibility tree; the card stack inside
 * carries the loading announcement.
 */
function BillingPageSkeleton() {
  return (
    <div className="space-y-6" data-testid="billing-page-skeleton">
      <Tabs.Root value="billing">
        <Tabs.List aria-hidden>
          <Tabs.Trigger value="billing" disabled>
            {/* Matches the trigger's 18px line box, so the placeholder bar is
                exactly as tall as one holding a real label. */}
            <Skeleton className="h-[18px] w-12 rounded-md" />
          </Tabs.Trigger>
          <Tabs.Trigger value="usage" disabled>
            <Skeleton className="h-[18px] w-12 rounded-md" />
          </Tabs.Trigger>
        </Tabs.List>
        <Tabs.Panel value="billing" className="pt-4">
          <BillingTabSkeleton />
        </Tabs.Panel>
      </Tabs.Root>
    </div>
  );
}

function BillingTabContent() {
  const { t } = useTranslation("settings");
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
  const [proOnboardingOpen, setProOnboardingOpen] = useState(false);

  // Abandoned-checkout bonus: the cancel signal lives in state (not the URL)
  // because BillingStatusHandler immediately navigate-replaces the query
  // string away. It's a timestamp, not a boolean: this tab is a persistent
  // mount on Electron/iOS, so a second cancel must read as a fresh trigger
  // (the hook re-asks the server) instead of latching after the first. The
  // server's answer alone decides whether the offer shows. Local dismissal
  // keeps a declined offer closed until the next cancel re-arms it.
  const [checkoutCancelledAt, setCheckoutCancelledAt] = useState<number | null>(
    null,
  );
  const [bonusDismissed, setBonusDismissed] = useState(false);
  const onCheckoutCancelled = useCallback(() => {
    setCheckoutCancelledAt(Date.now());
    setBonusDismissed(false);
  }, []);
  const { showOffer, amountUsd } = useCheckoutBonusOffer(checkoutCancelledAt);
  const onBonusOpenChange = useCallback((open: boolean) => {
    if (!open) {
      setBonusDismissed(true);
    }
  }, []);

  useEffect(() => {
    // Only consume the modal-opening params once billing is usable (signed
    // in). While the tab shows the login notice (`"disabled"`), leave them
    // in the URL so PlatformLoginNotice carries them through sign-in and
    // the target modal opens on return instead of being silently dropped.
    if (billingGate !== "full") {
      return;
    }
    const hasAdjustPlan = searchParams.has("adjust_plan");
    const hasProOnboarding = searchParams.has("pro_onboarding");
    if (!hasAdjustPlan && !hasProOnboarding) {
      return;
    }
    if (hasAdjustPlan) {
      setPlanModalOpen(true);
    }
    if (hasProOnboarding) {
      setProOnboardingOpen(true);
    }
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("adjust_plan");
        next.delete("pro_onboarding");
        return next;
      },
      { replace: true },
    );
  }, [billingGate, searchParams, setSearchParams]);

  const hasSessionId = searchParams.has("session_id");
  const closeOnboarding = useCallback(() => {
    setProOnboardingOpen(false);
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.delete("session_id");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);
  // Routed through `?pro_onboarding` (rather than opening state directly) so
  // the nudge exercises the same path as a deeplink.
  const openProOnboarding = useCallback(() => {
    setSearchParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        next.set("pro_onboarding", "");
        return next;
      },
      { replace: true },
    );
  }, [setSearchParams]);

  if (billingGate === "disabled") {
    return (
      <div className="space-y-4">
        <PlatformLoginNotice>
          {t("billingPage.platformLoginNotice")}
        </PlatformLoginNotice>
      </div>
    );
  }

  if (isLifecycleLoading) {
    return <BillingTabSkeleton />;
  }

  const showPlanManagement = isPlatformHosted;
  // The pro onboarding wizard is organization-scoped — `useProProvisioning`
  // targets the subscription's `primary_assistant_id` and falls back to the
  // active assistant only when the payload names none — so it is gated on the
  // organization rather than on the active assistant's hosting. An
  // organization holding both hosting types would otherwise drop a completed
  // checkout's `session_id` whenever a self-hosted assistant is selected.
  // Every other surface below reads the active assistant and stays gated on
  // `showPlanManagement`.
  const showProOnboarding =
    showPlanManagement || hasSessionId || proOnboardingOpen;

  if (!isPlatformHosted && platformGate !== "gated") {
    return (
      <div className="space-y-4">
        <Notice tone="warning">{t("billingPage.billingUnavailable")}</Notice>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <BillingStatusHandler onCheckoutCancelled={onCheckoutCancelled} />
      <BillingPortalReturnHandler />
      {showPlanManagement && <GracePeriodBanner />}
      {showPlanManagement && (
        <FinishProSetupNotice onFinishSetup={openProOnboarding} />
      )}
      {showPlanManagement && (
        <PlanCard onManage={openPlanModal} onTierUpgraded={onTierUpgraded} />
      )}
      {showPlanManagement && (
        <AdjustPlanModal
          open={planModalOpen}
          onClose={closePlanModal}
          onTierUpgraded={onTierUpgraded}
        />
      )}
      <CheckoutBonusModal
        open={showOffer && !bonusDismissed}
        onOpenChange={onBonusOpenChange}
        amountUsd={amountUsd}
      />
      <PaymentMethodsCard />
      <BillingPanel />
      <InvoicesTable />
      {showProOnboarding && (
        <BillingOnboardingModal
          open={hasSessionId || proOnboardingOpen}
          onClose={closeOnboarding}
        />
      )}
      {showPlanManagement && (
        <BillingOnboardingModal
          mode="resize"
          open={resizeModalOpen}
          onClose={() => setResizeModalOpen(false)}
        />
      )}
    </div>
  );
}

function BillingTab() {
  return <BillingTabContent />;
}

function UsagePanel() {
  const assistantId = useActiveAssistantId();
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
  const { t } = useTranslation("settings");
  const billingGate = usePlatformGate();
  // The same gate with the pre-settle window kept distinct, for the hold
  // below. Every other branch here reads that window as `"disabled"`.
  const platformSessionPending = usePlatformGateWithPending() === "pending";
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const location = useLocation();
  // Driven here rather than in `PaymentMethodsCard`, which replays the
  // outcome: that card sits inside the billing tab panel, and a switch to
  // Usage would unmount the resolution after the params have already been
  // stripped from the URL. This component owns `Tabs.Root` and survives it.
  useSetupIntentReturn();
  // Shown when signed in (`"full"`); for a signed-out-but-reachable viewer
  // (`"disabled"`) it stays reachable only when the URL carries billing intent
  // (a deeplink / upgrade CTA / Stripe return), so the BillingTab login notice
  // can carry those params through sign-in. Normal signed-out browsing and
  // self-hosted (`"gated"`) see the Usage tab alone. See
  // `billing-tab-visibility.ts`.
  const showBillingTab = shouldShowBillingTab(billingGate, searchParams);

  // When Billing is available it leads the tab list and is the default;
  // Usage is reached via `?tab=usage`. With no Billing tab, Usage is all
  // there is.
  const wantsUsageTab = searchParams.get("tab") === "usage";
  const activeTab = showBillingTab && !wantsUsageTab ? "billing" : "usage";

  // Hold the tab decision through the pre-settle window unless the URL asks
  // for Usage: no session has resolved yet, so `activeTab` falls to "usage"
  // and a viewer heading for Billing would watch the Usage tree mount its own
  // skeletons and then get torn down when the probe lands. The gate bounds
  // its own pending state, so this cannot hold forever.
  const holdForPlatformSession = platformSessionPending && !wantsUsageTab;

  // Keep the active tab explicit in the URL so both tabs are symmetric and
  // the address bar always names what's shown: a bare `/settings/usage` — or
  // a stale `?tab=billing` after signing out — is rewritten to the resolved
  // tab. Gate on the *platform-session* probe settling, not just session
  // status: the local-gateway path flips `sessionStatus` to authenticated
  // while `platformSession` is still `"unknown"` (so `usePlatformGate()`
  // reads no session and Billing hasn't resolved as the default). Rewriting
  // in that window would lock `?tab=usage` and strand a signed-in viewer on
  // Usage once the session confirms.
  const isPlatformSessionSettled = useIsPlatformSessionSettled();
  useEffect(() => {
    if (!isPlatformSessionSettled) {
      return;
    }
    if (searchParams.get("tab") !== activeTab) {
      replaceSearchParams(navigate, location, (next) =>
        next.set("tab", activeTab),
      );
    }
  }, [isPlatformSessionSettled, searchParams, activeTab, navigate, location]);

  const handleTabChange = (value: string) => {
    replaceSearchParams(navigate, location, (next) => next.set("tab", value));
  };

  if (holdForPlatformSession) {
    return <BillingPageSkeleton />;
  }

  return (
    <div className="space-y-6">
      <Tabs.Root value={activeTab} onValueChange={handleTabChange}>
        <Tabs.List>
          {showBillingTab && (
            <Tabs.Trigger value="billing">
              {t("billingPage.billingTab")}
            </Tabs.Trigger>
          )}
          <Tabs.Trigger value="usage">{t("billingPage.usageTab")}</Tabs.Trigger>
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
