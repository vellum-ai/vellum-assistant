/**
 * Interaction tests for the PlansPage CTA checkout wiring and the `?package=`
 * deep link.
 *
 * A base subscriber clicking a package button (Power Up / Go Super / Unleash
 * Ultra) fires the Stripe upgrade for THAT package and redirects to the
 * returned checkout URL. An active Pro subscriber switches packages in place
 * (the confirm modal → change-package), and only an *ineligible* Pro sub —
 * cancelling or off an entitlement status — routes to the billing manage modal
 * (`?adjust_plan`), because change-package can only fail for it.
 *
 * The `?package=<key>` deep link reuses that same click handler, so it inherits
 * every guard: it opens the confirm modal for an eligible Pro sub, bails to
 * `?adjust_plan` for an ineligible one, no-ops on the current or an unknown
 * key, and never starts a checkout for a non-Pro user. The param is stripped
 * either way and consumed exactly once.
 *
 * Strategy mirrors adjust-plan-modal.test.tsx: mock the generated SDK to
 * capture the upgrade body and return a redirect, mock `openUrl` to capture the
 * redirect target, and force the platform-hosted gate open so the page mounts
 * its body instead of firing the not-ready redirect effect.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  act,
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
  SubscriptionResponse,
} from "@/generated/api/types.gen";
import {
  clearCheckoutIntent,
  readCheckoutIntent,
} from "@/lib/billing/checkout-intent";
import {
  makeProPackage,
  makeSuperPackage,
  makeUltraPackage,
} from "@/domains/settings/billing/plans/pro-package-test-fixtures";

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
  // PlansPage mounts `useChangeTiers`, which reads onboarding for a Pro sub;
  // resolve it from a fixture so the checkout tests stay hermetic.
  organizationsBillingSubscriptionOnboardingRetrieve: () =>
    Promise.resolve({
      data: {
        max_machine_tier: "medium",
        selected_storage_tier: "xs",
        selected_storage_gib: 10,
      },
      response: { ok: true },
    }),
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

// These tests only need the three catalog keys to exist and render their CTAs,
// so the packages come straight from the shared fixtures.
const MIGHTY = makeProPackage();
const SUPER = makeSuperPackage();
const ULTRA = makeUltraPackage();

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

function renderPage(
  subscription: SubscriptionResponse,
  entry = "/assistant/plans",
) {
  const client = new QueryClient({
    defaultOptions: {
      // The seeded cache is the only data source — the read endpoints aren't
      // mocked, so a background refetch would hit the network.
      queries: { retry: false, staleTime: Infinity, refetchOnMount: false },
    },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription,
  );
  client.setQueryData(
    organizationsBillingPlansRetrieveQueryKey(),
    fullCatalog(),
  );
  return {
    client,
    ...render(
      <MemoryRouter initialEntries={[entry]}>
        <QueryClientProvider client={client}>
          <PlansPage />
        </QueryClientProvider>
        <LocationProbe />
      </MemoryRouter>,
    ),
  };
}

beforeEach(() => {
  upgradeCall = null;
  openedUrl = null;
  // The stash also keeps an in-memory mirror, so clearing sessionStorage alone
  // leaves a prior test's intent readable.
  clearCheckoutIntent();
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
        // Off Electron the web return URL is kept — a browser can't open
        // the `vellum://` bounce the native return relies on.
        return_target: "web",
      });
      await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
      expect(readCheckoutIntent()).toMatchObject({
        kind: "package",
        packageKey: pkg,
      });
    });
  }
});

describe("PlansPage checkout — Pro subscriber", () => {
  // Below Mighty, Free reads "Downgrade to Free". Downgrading a Pro org to the
  // Free plan is a subscription cancellation, not a package switch — clicking it
  // opens a confirm step (then the Stripe billing portal, the same destination
  // as the adjust-plan modal's "Downgrade to Base"). The full confirm → portal
  // flow is covered in `plans-page.test.tsx`; here we only guard that it never
  // fires a Stripe checkout. This harness seeds the cache without mocking the
  // read endpoints, so the confirm/portal/location aren't asserted.
  test("a Free downgrade CTA never starts a Stripe checkout", () => {
    const { getByRole } = renderPage(proMightySubscription());

    fireEvent.click(getByRole("button", { name: "Downgrade to Free" }));

    expect(upgradeCall).toBeNull();
    expect(readCheckoutIntent()).toBeNull();
  });
});

// `?package=<key>` is the URL entry into the in-place package switch — the
// funnel marketing's upgrade CTAs and the checkout no-op bail land on. It calls
// the same handler a card click does, so every assertion below is really about
// a guard being inherited rather than re-implemented.
describe("PlansPage — ?package= deep link", () => {
  // Emptying the query leaves React Router with a bare "?" on the path, so the
  // assertion is on the param being gone rather than an exact string.
  const ON_PLANS_WITHOUT_PARAM = /^\/assistant\/plans\??$/;

  test("an eligible Pro sub opens the switch confirm for the requested package", async () => {
    const { findByText, getByTestId } = renderPage(
      proMightySubscription(),
      "/assistant/plans?package=super",
    );

    // The confirm modal — not a checkout, not a direct change-package.
    await findByText("Upgrade to Super");
    expect(upgradeCall).toBeNull();
    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
  });

  test("an ineligible Pro sub bails to the billing manage surface", async () => {
    const { getByTestId, queryByTestId } = renderPage(
      { ...proMightySubscription(), cancel_at_period_end: true },
      "/assistant/plans?package=super",
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toBe(
        "/assistant/settings/usage?tab=billing&adjust_plan",
      ),
    );
    expect(queryByTestId("confirm-package-switch-button")).toBeNull();
    expect(upgradeCall).toBeNull();
  });

  test("the current package is a no-op", async () => {
    const { getByTestId, queryByTestId } = renderPage(
      proMightySubscription(),
      "/assistant/plans?package=mighty",
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
    expect(queryByTestId("confirm-package-switch-button")).toBeNull();
    expect(upgradeCall).toBeNull();
  });

  test("an unknown package key is a no-op", async () => {
    const { getByTestId, queryByTestId } = renderPage(
      proMightySubscription(),
      "/assistant/plans?package=bogus",
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
    expect(queryByTestId("confirm-package-switch-button")).toBeNull();
    expect(upgradeCall).toBeNull();
  });

  test("a non-Pro sub starts no checkout, and the param is still dropped", async () => {
    const { getByTestId, queryByTestId } = renderPage(
      freeSubscription(),
      "/assistant/plans?package=super",
    );

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
    // A URL alone must never charge anyone: the base user still has to press
    // the card's CTA.
    expect(upgradeCall).toBeNull();
    expect(readCheckoutIntent()).toBeNull();
    expect(queryByTestId("confirm-package-switch-button")).toBeNull();
  });

  test("the param is consumed once — a later query settle doesn't reopen the modal", async () => {
    const { client, findByText, findByRole, getByTestId, queryByTestId } =
      renderPage(proMightySubscription(), "/assistant/plans?package=super");

    await findByText("Upgrade to Super");
    fireEvent.click(await findByRole("button", { name: "Cancel" }));
    await waitFor(() =>
      expect(queryByTestId("confirm-package-switch-button")).toBeNull(),
    );

    // A subscription refetch settling re-runs the effect; the one-shot ref (and
    // the already-stripped URL) keep it from reopening.
    act(() => {
      client.setQueryData(
        organizationsBillingSubscriptionRetrieveQueryKey(),
        proMightySubscription(),
      );
    });

    await waitFor(() =>
      expect(getByTestId("loc").textContent).toMatch(ON_PLANS_WITHOUT_PARAM),
    );
    expect(queryByTestId("confirm-package-switch-button")).toBeNull();
  });
});
