import { Loader2 } from "lucide-react";
import { Suspense, useCallback, useEffect, useState } from "react";

import { useNavigate, useSearchParams } from "react-router";

import { useQuery, useQueryClient } from "@tanstack/react-query";

import { useActiveAssistantId } from "@/assistant/use-active-assistant-id";
import { PlatformLoginNotice } from "@/components/platform-login-notice";
import { BillingOnboardingModal } from "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal";
import { shouldShowBillingTab } from "@/domains/settings/billing/billing-tab-visibility";
import { UsageTab } from "@/domains/settings/billing/usage/usage-tab";
import { AdjustPlanModal } from "@/domains/settings/components/adjust-plan-modal";
import { BillingPanel } from "@/domains/settings/components/billing-panel";
import { BillingPortalReturnHandler } from "@/domains/settings/components/billing-portal-return-handler";
import { BillingUsagePanel } from "@/domains/settings/components/billing-usage/billing-usage-panel";
import { GracePeriodBanner } from "@/domains/settings/components/grace-period-banner";
import { InvoicesTable } from "@/domains/settings/components/invoices-table";
import { PlanCard } from "@/domains/settings/components/plan-card";
import { ReferralPanel } from "@/domains/settings/components/referral-panel";
import { TierUpgradeResizeModal } from "@/domains/settings/components/tier-upgrade-resize-modal";
import {
    organizationsBillingSubscriptionOnboardingRetrieveOptions,
    organizationsBillingSubscriptionRetrieveOptions,
    organizationsBillingSummaryRetrieveOptions,
} from "@/generated/api/@tanstack/react-query.gen";
import {
    useActiveAssistantIsPlatformHosted,
    useActiveAssistantLifecycleIsLoading,
    usePlatformGate,
} from "@/hooks/use-platform-gate";
import { useIsPlatformSessionSettled } from "@/stores/auth-store";
import { routes } from "@/utils/routes";
import { Button } from "@vellumai/design-library/components/button";
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

        navigate(routes.settings.usageBilling, { replace: true });
    }, [searchParams, navigate, queryClient]);

    return null;
}

/**
 * Re-entry nudge into the pro onboarding wizard: shown while the org is on Pro
 * but the assistant email/subdomain offered by the onboarding flow is still
 * unconfigured (`domain_setup_available`).
 */
function FinishProSetupNotice({ onFinishSetup }: { onFinishSetup: () => void }) {
    const { data: subscription } = useQuery(
        organizationsBillingSubscriptionRetrieveOptions(),
    );
    const isPro = subscription?.plan_id === "pro";
    const { data: onboarding } = useQuery({
        ...organizationsBillingSubscriptionOnboardingRetrieveOptions(),
        enabled: isPro,
    });

    if (!isPro || onboarding?.domain_setup_available !== true) {
        return null;
    }

    return (
        <Notice
            tone="info"
            title="Finish setting up your Pro plan"
            actions={
                <Button
                    variant="outlined"
                    size="compact"
                    onClick={onFinishSetup}
                    data-testid="finish-pro-setup-button"
                >
                    Finish setup
                </Button>
            }
            data-testid="finish-pro-setup-notice"
        >
            Your assistant&apos;s email address hasn&apos;t been set up yet.
        </Notice>
    );
}

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
    const [proOnboardingOpen, setProOnboardingOpen] = useState(false);

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
        setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.delete("adjust_plan");
            next.delete("pro_onboarding");
            return next;
        }, { replace: true });
    }, [billingGate, searchParams, setSearchParams]);

    const hasSessionId = searchParams.has("session_id");
    const closeOnboarding = useCallback(() => {
        setProOnboardingOpen(false);
        setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.delete("session_id");
            return next;
        }, { replace: true });
    }, [setSearchParams]);
    // Routed through `?pro_onboarding` (rather than opening state directly) so
    // the nudge exercises the same path as a deeplink.
    const openProOnboarding = useCallback(() => {
        setSearchParams((prev) => {
            const next = new URLSearchParams(prev);
            next.set("pro_onboarding", "");
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
            {showPlanManagement && (
                <FinishProSetupNotice onFinishSetup={openProOnboarding} />
            )}
            {showPlanManagement && <PlanCard onManage={openPlanModal} />}
            {showPlanManagement && (
                <AdjustPlanModal open={planModalOpen} onClose={closePlanModal} onTierUpgraded={onTierUpgraded} />
            )}
            <Suspense fallback={null}>
                <BillingPanel />
            </Suspense>
            <ReferralPanel />
            <Suspense fallback={null}>
                <InvoicesTable />
            </Suspense>
            {showPlanManagement && (
                <BillingOnboardingModal
                    open={hasSessionId || proOnboardingOpen}
                    onClose={closeOnboarding}
                />
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
    const billingGate = usePlatformGate();
    const [searchParams, setSearchParams] = useSearchParams();
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
    const activeTab =
        showBillingTab && searchParams.get("tab") !== "usage" ? "billing" : "usage";

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
            const next = new URLSearchParams(searchParams);
            next.set("tab", activeTab);
            setSearchParams(next, { replace: true });
        }
    }, [isPlatformSessionSettled, searchParams, activeTab, setSearchParams]);

    const handleTabChange = (value: string) => {
        const next = new URLSearchParams(searchParams);
        next.set("tab", value);
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
