/**
 * Tests for the PlanCard credit-bundle row: a Pro org with a selected credit
 * tier shows the catalog label + monthly price; null shows no row; the row is
 * catalog-gated (suppressed when the Pro plan has no `credit_tiers`).
 *
 * Strategy: pre-populate the React Query cache so the card's `useQuery` calls
 * resolve synchronously — `renderToStaticMarkup` is single-pass, so a pending
 * query would otherwise report `isLoading` and render the spinner.
 */

import { describe, expect, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderToStaticMarkup } from "react-dom/server";

import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  CreditTier,
  PlanListResponse,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

import { PlanCard } from "./plan-card";

const CREDIT_TIERS: CreditTier[] = [
  {
    tier: "credits_25",
    label: "25 credits",
    credits_usd: 25,
    price_cents: 2500,
    lookup_key: "credits_25_lk",
  },
  {
    tier: "credits_50",
    label: "50 credits",
    credits_usd: 50,
    price_cents: 5000,
    lookup_key: "credits_50_lk",
  },
];

function proPlansResponse(creditTiers?: CreditTier[]): PlanListResponse {
  return {
    plans: [
      {
        id: "pro",
        name: "Pro",
        base_price_cents: 2000,
        base_lookup_key: "pro_base",
        billing_interval: "month",
        machine_tiers: [],
        storage_tiers: [],
        included_features: [],
        ...(creditTiers ? { credit_tiers: creditTiers } : {}),
      },
    ],
  };
}

function proSubscription(
  selectedCreditTier: string | null,
): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    selected_credit_tier: selectedCreditTier,
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
  client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), plans);
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <PlanCard onManage={() => {}} />
    </QueryClientProvider>,
  );
}

describe("PlanCard credit bundle", () => {
  test("shows the bundle row with the catalog label and monthly price", () => {
    const html = renderCard(
      proSubscription("credits_50"),
      proPlansResponse(CREDIT_TIERS),
    );
    expect(html).toContain("plan-card-credit-bundle");
    expect(html).toContain("Monthly credits: 50 credits ($50/mo)");
  });

  test("renders no bundle row when the selected tier is null", () => {
    const html = renderCard(
      proSubscription(null),
      proPlansResponse(CREDIT_TIERS),
    );
    expect(html).not.toContain("plan-card-credit-bundle");
  });

  test("is catalog-gated: no bundle row when the plan has no credit_tiers", () => {
    const html = renderCard(
      proSubscription("credits_50"),
      proPlansResponse(undefined),
    );
    expect(html).not.toContain("plan-card-credit-bundle");
  });

  test("falls back to the raw tier key when no catalog match exists", () => {
    const html = renderCard(
      proSubscription("credits_200"),
      proPlansResponse(CREDIT_TIERS),
    );
    expect(html).toContain("plan-card-credit-bundle");
    expect(html).toContain("Monthly credits: credits_200");
  });
});
