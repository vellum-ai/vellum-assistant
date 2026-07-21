/**
 * Interaction tests for the PlansPage CTA checkout wiring.
 *
 * A base subscriber clicking a package button (Power Up / Go Super / Unleash
 * Ultra) fires the Stripe upgrade for THAT package and redirects to the
 * returned checkout URL. A Pro subscriber instead routes to the billing
 * manage modal (`?adjust_plan`), because the platform upgrade endpoint no-ops
 * for an active Pro org.
 *
 * Strategy mirrors adjust-plan-modal.test.tsx: mock the generated SDK to
 * capture the upgrade body and return a redirect, mock `openUrl` to capture the
 * redirect target, and force the platform-hosted gate open so the page mounts
 * its body instead of firing the not-ready redirect effect.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter, useLocation } from "react-router";

import * as sdkGen from "@/generated/api/sdk.gen";
import * as browserRuntime from "@/runtime/browser";
import * as platformGate from "@/hooks/use-platform-gate";
import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  PlanListResponse,
  ProPackage,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

const CHECKOUT_URL = "https://stripe.test/checkout/session";

type Captured = { body?: unknown };
let upgradeCall: Captured | null = null;
let openedUrl: string | null = null;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionUpgradeCreate: (opts: Captured) => {
    upgradeCall = opts;
    return Promise.resolve({
      data: { status: "redirect", checkout_url: CHECKOUT_URL },
      response: { ok: true },
    });
  },
}));

mock.module("@/runtime/browser", () => ({
  ...browserRuntime,
  openUrl: (url: string) => {
    openedUrl = url;
    return Promise.resolve();
  },
}));

// Force the platform-hosted gate open so the page mounts its pricing body
// instead of firing the self-hosted / not-ready redirect effect.
mock.module("@/hooks/use-platform-gate", () => ({
  ...platformGate,
  usePlatformGate: () => "full",
  useActiveAssistantIsPlatformHosted: () => true,
  useActiveAssistantLifecycleIsLoading: () => false,
}));

// Render avatar placeholders; skip the lazy compositor bundle in the DOM test.
mock.module("@/utils/use-bundled-avatar-components", () => ({
  preloadBundledAvatarComponents: () => {},
  useBundledAvatarComponents: () => null,
}));

const { PlansPage } = await import("./plans-page");

function makePackage(overrides: Partial<ProPackage>): ProPackage {
  return {
    key: "mighty",
    name: "Mighty",
    description: "",
    version: 1,
    machine_tier: null,
    storage_tier: "xs",
    credit_tier: "credits_25",
    machine_size: null,
    storage_gib: 10,
    credits_usd: 25,
    include_platform_fee: false,
    base_price_cents: 0,
    machine_price_cents: 0,
    storage_price_cents: 0,
    credit_price_cents: 0,
    total_price_cents: 3000,
    ...overrides,
  };
}

const MIGHTY = makePackage({});
const SUPER = makePackage({
  key: "super",
  name: "Super",
  machine_size: "medium",
  storage_gib: 25,
  credits_usd: 50,
  total_price_cents: 10000,
});
const ULTRA = makePackage({
  key: "ultra",
  name: "Ultra",
  machine_size: "large",
  storage_gib: 50,
  credits_usd: 100,
  total_price_cents: 20000,
});

function fullCatalog(): PlanListResponse {
  return {
    plans: [
      {
        id: "base",
        name: "Free",
        price_cents: 0,
        billing_interval: "month",
        included_features: [],
      },
      {
        id: "pro",
        name: "Pro",
        base_lookup_key: "pro_base",
        base_price_cents: 2000,
        billing_interval: "month",
        included_features: [],
        machine_tiers: [],
        storage_tiers: [],
        packages: [MIGHTY, SUPER, ULTRA],
      },
    ],
  };
}

function freeSubscription(): SubscriptionResponse {
  return {
    plan_id: "base",
    status: "active",
    renewal_date: null,
    current_period_end: "2026-07-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    entitlements: { managed_email: false, phone_number: false },
  };
}

function proMightySubscription(): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_end: "2026-07-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    package: { key: "mighty", name: "Mighty", version: 1, customized: false },
    entitlements: { managed_email: false, phone_number: false },
  };
}

function LocationProbe() {
  const location = useLocation();
  return <div data-testid="loc">{location.pathname + location.search}</div>;
}

function renderPage(subscription: SubscriptionResponse) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription,
  );
  client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), fullCatalog());
  return render(
    <MemoryRouter initialEntries={["/assistant/plans"]}>
      <QueryClientProvider client={client}>
        <PlansPage />
      </QueryClientProvider>
      <LocationProbe />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  upgradeCall = null;
  openedUrl = null;
});

afterEach(() => {
  cleanup();
});

describe("PlansPage checkout — base subscriber", () => {
  const cases = [
    { label: "Power Up", pkg: "mighty" },
    { label: "Go Super", pkg: "super" },
    { label: "Unleash Ultra", pkg: "ultra" },
  ];

  for (const { label, pkg } of cases) {
    test(`"${label}" starts Stripe checkout for the ${pkg} package`, async () => {
      const { getByRole } = renderPage(freeSubscription());

      fireEvent.click(getByRole("button", { name: label }));

      await waitFor(() => expect(upgradeCall).not.toBeNull());
      expect(upgradeCall!.body).toEqual({
        target_plan_id: "pro",
        package: pkg,
        confirm: true,
      });
      await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    });
  }
});

describe("PlansPage checkout — Pro subscriber", () => {
  test("routes to the manage modal instead of a package checkout", async () => {
    const { getByRole, getByTestId } = renderPage(proMightySubscription());

    fireEvent.click(getByRole("button", { name: "Go Super" }));

    await waitFor(() => {
      expect(getByTestId("loc").textContent).toBe(
        "/assistant/settings/usage?tab=billing&adjust_plan",
      );
    });
    // The upgrade endpoint no-ops for an active Pro org, so no checkout fires.
    expect(upgradeCall).toBeNull();
    expect(openedUrl).toBeNull();
  });
});
