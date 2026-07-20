/**
 * BillingTab pro-onboarding re-entry wiring.
 *
 * `?pro_onboarding` reopens the post-checkout onboarding wizard without a
 * Stripe `session_id`, and the "Finish Pro setup" nudge renders only for a
 * Pro subscription with no assistant email domain registered yet (the
 * platform's `domain_setup_available` flag stays true forever, so the domains
 * list is the real signal).
 *
 * Strategy mirrors plans-page-checkout.test.tsx: mock the generated SDK with
 * mutable responses, force the platform-hosted gate open, and stub the heavy
 * billing children so the page wiring under test is the only moving part. The
 * onboarding modal stub reports its `open` prop via a data attribute.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";

import {
    assistantsDomainsListQueryKey,
    organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
    organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import * as sdkGen from "@/generated/api/sdk.gen";
import type {
    Assistant,
    OnboardingStateResponse,
    PaginatedAssistantDomainList,
    SubscriptionResponse,
} from "@/generated/api/types.gen";
import * as platformGate from "@/hooks/use-platform-gate";
import * as authStore from "@/stores/auth-store";

let subscriptionResponse: SubscriptionResponse;
let onboardingResponse: OnboardingStateResponse;
let domainsResponse: PaginatedAssistantDomainList;
let onboardingCalls = 0;
let domainsCalls = 0;

const ACTIVE_ASSISTANT = { id: "assistant-1" } as unknown as Assistant;

mock.module("@/generated/api/sdk.gen", () => ({
    ...sdkGen,
    organizationsBillingSubscriptionRetrieve: () =>
        Promise.resolve({ data: subscriptionResponse, response: { ok: true } }),
    organizationsBillingSubscriptionOnboardingRetrieve: () => {
        onboardingCalls += 1;
        return Promise.resolve({
            data: onboardingResponse,
            response: { ok: true },
        });
    },
    assistantsActiveRetrieve: () =>
        Promise.resolve({ data: ACTIVE_ASSISTANT, response: { ok: true } }),
    assistantsDomainsList: () => {
        domainsCalls += 1;
        return Promise.resolve({ data: domainsResponse, response: { ok: true } });
    },
}));

// Force the platform-hosted gate open so BillingTab mounts its plan-management
// body instead of the login notice / unavailable states.
mock.module("@/hooks/use-platform-gate", () => ({
    ...platformGate,
    usePlatformGate: () => "full",
    useActiveAssistantIsPlatformHosted: () => true,
    useActiveAssistantLifecycleIsLoading: () => false,
}));

mock.module("@/stores/auth-store", () => ({
    ...authStore,
    useIsPlatformSessionSettled: () => true,
}));

mock.module(
    "@/domains/settings/billing/pro-onboarding/billing-onboarding-modal",
    () => ({
        BillingOnboardingModal: ({ open }: { open: boolean }) => (
            <div
                data-testid="onboarding-modal"
                data-open={open ? "true" : "false"}
            />
        ),
    }),
);
mock.module("@/domains/settings/billing/usage/usage-tab", () => ({
    UsageTab: () => null,
}));
mock.module("@/domains/settings/components/adjust-plan-modal", () => ({
    AdjustPlanModal: () => null,
}));
mock.module("@/domains/settings/components/billing-panel", () => ({
    BillingPanel: () => null,
}));
mock.module(
    "@/domains/settings/components/billing-portal-return-handler",
    () => ({ BillingPortalReturnHandler: () => null }),
);
mock.module(
    "@/domains/settings/components/billing-usage/billing-usage-panel",
    () => ({ BillingUsagePanel: () => null }),
);
mock.module("@/domains/settings/components/grace-period-banner", () => ({
    GracePeriodBanner: () => null,
}));
mock.module("@/domains/settings/components/invoices-table", () => ({
    InvoicesTable: () => null,
}));
mock.module("@/domains/settings/components/plan-card", () => ({
    PlanCard: () => null,
}));
mock.module("@/domains/settings/components/referral-panel", () => ({
    ReferralPanel: () => null,
}));
mock.module("@/domains/settings/components/tier-upgrade-resize-modal", () => ({
    TierUpgradeResizeModal: () => null,
}));

const { BillingPage } = await import("./billing-page");

function makeSubscription(planId: "base" | "pro"): SubscriptionResponse {
    return {
        plan_id: planId,
        status: "active",
        renewal_date: null,
        current_period_end: "2026-08-01T00:00:00Z",
        cancel_at_period_end: false,
        cancel_at: null,
        entitlements: { managed_email: false, phone_number: false },
    };
}

function makeOnboarding(domainSetupAvailable: boolean): OnboardingStateResponse {
    return {
        max_machine_tier: "large",
        selected_storage_tier: "md",
        selected_storage_gib: 50,
        pvc_ready: true,
        domain_setup_available: domainSetupAvailable,
        primary_assistant_id: "assistant-1",
    };
}

function makeDomains(hasDomain: boolean): PaginatedAssistantDomainList {
    return {
        count: hasDomain ? 1 : 0,
        next: null,
        previous: null,
        results: hasDomain
            ? [
                  {
                      id: "domain-1",
                      subdomain: "velly",
                      created: "2026-07-01T00:00:00Z",
                      modified: "2026-07-01T00:00:00Z",
                  },
              ]
            : [],
    };
}

const domainsQueryKey = () =>
    assistantsDomainsListQueryKey({ path: { assistant_id: "assistant-1" } });

function LocationProbe() {
    const location = useLocation();
    return <div data-testid="loc">{location.pathname + location.search}</div>;
}

function renderPage(search = "?tab=billing") {
    const client = new QueryClient({
        defaultOptions: { queries: { retry: false } },
    });
    const view = render(
        <MemoryRouter initialEntries={[`/assistant/settings/usage${search}`]}>
            <QueryClientProvider client={client}>
                <BillingPage />
                <LocationProbe />
            </QueryClientProvider>
        </MemoryRouter>,
    );
    return { client, ...view };
}

beforeEach(() => {
    subscriptionResponse = makeSubscription("pro");
    onboardingResponse = makeOnboarding(true);
    domainsResponse = makeDomains(false);
    onboardingCalls = 0;
    domainsCalls = 0;
});

afterEach(() => {
    cleanup();
});

describe("BillingTab ?pro_onboarding param", () => {
    test("opens the onboarding modal without a session_id and strips the param", async () => {
        const { getByTestId } = renderPage("?tab=billing&pro_onboarding");

        await waitFor(() =>
            expect(
                getByTestId("onboarding-modal").getAttribute("data-open"),
            ).toBe("true"),
        );
        expect(getByTestId("loc").textContent).toBe(
            "/assistant/settings/usage?tab=billing",
        );
    });
});

describe("Finish Pro setup nudge", () => {
    test("renders for Pro with no domain registered and reopens the wizard", async () => {
        const { getByTestId } = renderPage();

        await waitFor(() =>
            expect(getByTestId("finish-pro-setup-notice")).toBeTruthy(),
        );
        expect(getByTestId("onboarding-modal").getAttribute("data-open")).toBe(
            "false",
        );

        fireEvent.click(getByTestId("finish-pro-setup-button"));

        await waitFor(() =>
            expect(
                getByTestId("onboarding-modal").getAttribute("data-open"),
            ).toBe("true"),
        );
        // The transient param is consumed straight back out of the URL.
        expect(getByTestId("loc").textContent).toBe(
            "/assistant/settings/usage?tab=billing",
        );
    });

    test("hidden for Pro when a domain is already registered", async () => {
        // `domain_setup_available` is still true (the platform hard-codes it
        // for every active-Pro org) — the registered domain alone must hide
        // the nudge.
        domainsResponse = makeDomains(true);
        const { client, queryByTestId } = renderPage();

        await waitFor(() =>
            expect(client.getQueryData(domainsQueryKey())).toBeTruthy(),
        );
        expect(queryByTestId("finish-pro-setup-notice")).toBeNull();
    });

    test("hidden on the base plan; onboarding and domains endpoints are never queried", async () => {
        subscriptionResponse = makeSubscription("base");
        const { client, queryByTestId } = renderPage();

        await waitFor(() =>
            expect(
                client.getQueryData(
                    organizationsBillingSubscriptionRetrieveQueryKey(),
                ),
            ).toBeTruthy(),
        );
        expect(queryByTestId("finish-pro-setup-notice")).toBeNull();
        expect(onboardingCalls).toBe(0);
        expect(domainsCalls).toBe(0);
    });

    test("hidden for Pro when domain setup is unavailable, without querying domains", async () => {
        onboardingResponse = makeOnboarding(false);
        const { client, queryByTestId } = renderPage();

        await waitFor(() =>
            expect(
                client.getQueryData(
                    organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
                ),
            ).toBeTruthy(),
        );
        expect(queryByTestId("finish-pro-setup-notice")).toBeNull();
        expect(domainsCalls).toBe(0);
    });
});
