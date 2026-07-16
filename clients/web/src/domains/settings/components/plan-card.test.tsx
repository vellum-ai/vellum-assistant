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
    <QueryClientProvider client={client}>
      <PlanCard onManage={() => {}} />
    </QueryClientProvider>,
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

  test("delta labels are data-faithful (no bogus arrows, no fake 'Standard')", () => {
    const html = renderCard(baseSubscription(), basePlansResponse());
    // Mighty keeps the standard machine (machine_size null): the machine and
    // vCPU chips must show a bare value, not an invented "X → Y" arrow, and
    // never the literal word "Standard" as a fake upgrade target. (The `'` in
    // "vCPU's" is HTML-escaped by renderToStaticMarkup, so match the stem.)
    expect(html).toContain("Small Machine");
    expect(html).toContain("2 vCPU");
    expect(html).not.toContain("Small →");
    expect(html).not.toContain("Standard");
    // Storage really changes (free's 4 GiB baseline → Mighty's 10), so the
    // arrow form is kept.
    expect(html).toContain("4 → 10 GB");
    expect(html).not.toContain("0 → 10 GB");
  });
});
