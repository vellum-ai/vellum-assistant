/**
 * Tests for the PlanCard: verifies the plan name, renewal text, the action
 * button (now in the plan row), and the recommended-upgrade banner render
 * correctly. The card no longer shows a credit bundle label or an invoices
 * button (invoices moved to an inline table on the billing page).
 *
 * Strategy: pre-populate the React Query cache so the card's `useQuery` calls
 * resolve synchronously — `renderToStaticMarkup` is single-pass, so a pending
 * query would otherwise report `isLoading` and render the spinner. The avatar
 * compositor loads lazily via `useEffect`, which doesn't fire under
 * `renderToStaticMarkup`, so avatars render as same-size placeholders here.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";
import { MemoryRouter } from "react-router";

import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  PlanListResponse,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

import { PlanCard } from "./plan-card";

function basePlansResponse(): PlanListResponse {
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
        packages: [
          {
            key: "mighty",
            name: "Mighty",
            description:
              "10 GB of storage and $25 in monthly credits on the standard machine.",
            version: 1,
            machine_tier: null,
            storage_tier: "xs",
            credit_tier: "credits_25",
            machine_size: null,
            storage_gib: 10,
            credits_usd: 25,
            include_platform_fee: false,
            base_price_cents: 4000,
            machine_price_cents: 0,
            storage_price_cents: 0,
            credit_price_cents: 0,
            total_price_cents: 4000,
          },
        ],
      },
    ],
  };
}

function baseSubscription(): SubscriptionResponse {
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

/** Catalog with both Mighty and Super, so `nextPackageUp("mighty")` → Super. */
function plansWithSuper(): PlanListResponse {
  const plans = basePlansResponse();
  const pro = plans.plans.find((p) => p.id === "pro");
  if (pro && "packages" in pro && pro.packages) {
    pro.packages.push({
      key: "super",
      name: "Super",
      description:
        "Medium machine, 30 GB of storage, and $45 in monthly credits.",
      version: 1,
      machine_tier: "medium",
      storage_tier: "s",
      credit_tier: "credits_45",
      machine_size: "medium",
      storage_gib: 30,
      credits_usd: 45,
      include_platform_fee: true,
      base_price_cents: 1000,
      machine_price_cents: 3500,
      storage_price_cents: 1000,
      credit_price_cents: 4500,
      total_price_cents: 10000,
    });
  }
  return plans;
}

/** A subscriber currently on the Mighty Pro package. */
function proMightySubscription(): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_end: "2026-08-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    package: { key: "mighty", name: "Mighty", version: 1, customized: false },
    entitlements: { managed_email: false, phone_number: false },
  };
}

function renderCard(
  subscription: SubscriptionResponse,
  plans: PlanListResponse,
): string {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    subscription,
  );
  client.setQueryData(
    organizationsBillingPlansRetrieveQueryKey(),
    plans,
  );
  return renderToStaticMarkup(
    // MemoryRouter supplies the router context PlanCard's useNavigate needs.
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PlanCard onManage={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

describe("PlanCard", () => {
  test("shows the plan name and renewal text for a base plan", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).toContain("plan-card-name");
    expect(html).toContain("Free");
    expect(html).toContain("plan-card-renews");
    expect(html).toContain("auto renew");
  });

  test("shows the upgrade button for a base plan", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).toContain("plan-card-upgrade-button");
    expect(html).toContain("View Plans");
  });

  test("does not render the invoices button (moved to inline table)", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).not.toContain("plan-card-invoices-button");
  });

  test("renders the recommended-upgrade banner (Mighty from Free)", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    expect(html).toContain("recommended-upgrade-button");
    expect(html).toContain("Recommended Upgrade");
    expect(html).toContain("Mighty");
  });

  test("no upgrade banner when the package catalog is empty (flag off)", () => {
    const plans = basePlansResponse();
    const pro = plans.plans.find((p) => p.id === "pro");
    if (pro && "packages" in pro) {
      pro.packages = [];
    }
    const html = renderCard(baseSubscription(), plans);
    expect(html).not.toContain("recommended-upgrade-button");
    expect(html).not.toContain("Recommended Upgrade");
  });

  test("Free → Mighty chips: credits, storage, and the larger-machines unlock", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    // Mighty keeps the small baseline machine (machine_size null), so the third
    // chip advertises the Pro larger-machines unlock rather than a no-op
    // "Small Machine" row. The vCPU chip is gone entirely.
    expect(html).toContain("Larger machines");
    expect(html).not.toContain("vCPU");
    expect(html).not.toContain("Small Machine");
    expect(html).not.toContain("Standard");
    // Credits step from Free's $0 to Mighty's $25 (arrow form, real change),
    // labelled per-month.
    expect(html).toContain("$0 → $25 credits/mo");
    // Storage really changes (free's 4 GiB baseline → Mighty's 10 GB).
    expect(html).toContain("4 → 10 GB");
    expect(html).not.toContain("0 → 10 GB");
  });

  test("Mighty → Super: recommends Super with a machine step-up chip", () => {
    const html = renderCard(proMightySubscription(), plansWithSuper());
    // On Mighty, the recommended upgrade is the next catalog package, Super.
    expect(html).toContain("recommended-upgrade-button");
    expect(html).toContain("Recommended Upgrade");
    expect(html).toContain("Super");
    // The machine tier actually changes here, so the third chip is the machine
    // arrow — NOT the larger-machines unlock (that's only the Free → Pro step).
    expect(html).toContain("Small → Medium Machine");
    expect(html).not.toContain("Larger machines");
    // Credits and storage step up from Mighty's values.
    expect(html).toContain("$25 → $45 credits/mo");
    expect(html).toContain("10 → 30 GB");
    // The current-plan row shows the actual package name "Mighty" (not the
    // generic plan name "Pro").
    expect(html).toContain("plan-card-name");
    expect(html).toContain("Mighty");
    expect(html).not.toContain("Pro");
  });

  test("current-plan row labels a customized package as custom", () => {
    const subscription = proMightySubscription();
    subscription.package = {
      key: "mighty",
      name: "Mighty",
      version: 1,
      customized: true,
    };
    const html = renderCard(subscription, plansWithSuper());
    // A plan whose tiers diverged from the pinned package reads "Mighty
    // (Custom)" so it doesn't masquerade as the stock package.
    expect(html).toContain("Mighty (Custom)");
  });
});
