/**
 * Tests for the PlansPage takeover: verifies the full catalog render (headline,
 * four tier columns, catalog-derived prices/features, CTA labels, custom-plan
 * row, docs footer), the current-plan disabling, and the empty-catalog
 * (`pro-packages` flag off) fallback.
 *
 * Strategy mirrors `plan-card.test.tsx`: seed the React Query cache so the
 * page's `useQuery` calls resolve synchronously — `renderToStaticMarkup` is
 * single-pass, so a pending query would report `isLoading` and render the
 * spinner instead. The page uses no Zustand store (React Query + react-router
 * + local `useState` only), so static markup is a faithful first paint. The
 * avatar compositor loads lazily via `useEffect`, which doesn't fire under
 * `renderToStaticMarkup`, so avatars render as same-size placeholders. The
 * empty-catalog redirect also lives in a `useEffect`, so the pre-redirect
 * markup asserted here is the loading spinner, never the pricing grid.
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
  ProPackage,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

import { getPlanTierCopy } from "./plans-copy";
import { PlansPage } from "./plans-page";

/** A fully-typed Pro package with Mighty defaults; override per tier. */
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

function plansWith(packages: ProPackage[]): PlanListResponse {
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
        packages,
      },
    ],
  };
}

function fullCatalog(): PlanListResponse {
  return plansWith([MIGHTY, SUPER, ULTRA]);
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

function renderPage(
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
    // MemoryRouter supplies the router context PlansPage's useNavigate needs.
    <MemoryRouter>
      <QueryClientProvider client={client}>
        <PlansPage />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

function count(html: string, needle: RegExp): number {
  return (html.match(needle) ?? []).length;
}

describe("PlansPage — full catalog render", () => {
  test("renders the headline and all four tier names", () => {
    const html = renderPage(freeSubscription(), fullCatalog());
    expect(html).toContain("Plans designed to empower you");
    expect(html).toContain("Free");
    expect(html).toContain("Mighty");
    expect(html).toContain("Super");
    expect(html).toContain("Ultra");
  });

  test("formats prices from the catalog totals (and $0 for free)", () => {
    const html = renderPage(freeSubscription(), fullCatalog());
    expect(html).toContain("$0/month");
    expect(html).toContain("$30/month");
    expect(html).toContain("$100/month");
    expect(html).toContain("$200/month");
  });

  test("shows the Most Popular badge exactly once", () => {
    const html = renderPage(freeSubscription(), fullCatalog());
    // The badge text is "Most Popular"; the all-caps look is CSS `uppercase`,
    // which renderToStaticMarkup does not apply.
    expect(count(html, /Most Popular/g)).toBe(1);
  });

  test("derives feature rows from the fixture (storage, credits, machine)", () => {
    const html = renderPage(freeSubscription(), fullCatalog());
    // Storage rows.
    expect(html).toContain("10 GiB Storage");
    expect(html).toContain("25 GiB Storage");
    expect(html).toContain("50 GiB Storage");
    // Free plan's baseline storage (FREE_STORAGE_GIB).
    expect(html).toContain("4 GiB Storage");
    // Credits row, formatted from credits_usd.
    expect(html).toContain("$25 in credits per month");
    // Machine "Computer" labels; a null machine_size renders "Small".
    expect(html).toContain("Small Computer");
    expect(html).toContain("Medium Computer");
    expect(html).toContain("Large Computer");
    // Copy-driven extra feature appended after the catalog rows.
    expect(html).toContain("Assistant email and subdomain");
  });

  test("uses the correct 'Includes:' label (not the Figma typo)", () => {
    const html = renderPage(freeSubscription(), fullCatalog());
    expect(html).toContain("Includes:");
    expect(html).not.toContain("Inlcudes:");
  });

  test("renders the per-tier CTA labels", () => {
    const html = renderPage(freeSubscription(), fullCatalog());
    expect(html).toContain("Power Up");
    expect(html).toContain("Go Super");
    expect(html).toContain("Unleash Ultra");
  });

  test("renders the custom-plan row and docs footer", () => {
    const html = renderPage(freeSubscription(), fullCatalog());
    expect(html).toContain("Custom Plan");
    expect(html).toContain("Configure");
    expect(html).toContain("Billed monthly");
    expect(html).toContain("Read our Docs.");
  });
});

describe("PlansPage — current-plan state", () => {
  test("free subscriber: Free is the current (disabled) plan, no Start Free", () => {
    const html = renderPage(freeSubscription(), fullCatalog());
    expect(html).toContain("Current Plan");
    // The Free card swaps its "Start Free" CTA for the current-plan label.
    expect(html).not.toContain("Start Free");
    // Exactly one column button is disabled — the current (Free) one. The
    // package CTAs stay enabled.
    expect(count(html, /disabled=""/g)).toBe(1);
  });

  test("pro subscriber on Mighty: Mighty is current, Free reverts to Start Free", () => {
    const html = renderPage(proMightySubscription(), fullCatalog());
    // Only the Mighty column is the current plan.
    expect(count(html, /Current Plan/g)).toBe(1);
    // Free is no longer current, so it shows its own CTA again.
    expect(html).toContain("Start Free");
    expect(count(html, /disabled=""/g)).toBe(1);
  });
});

describe("PlansPage — empty catalog (pro-packages flag off)", () => {
  test("renders the loading fallback, not the pricing grid", () => {
    // The redirect fires in a useEffect (not run by renderToStaticMarkup), so
    // the pre-redirect markup is the loading spinner.
    const html = renderPage(freeSubscription(), plansWith([]));
    expect(html).toContain("Loading plans");
    expect(html).not.toContain("Plans designed to empower you");
    expect(html).not.toContain("Mighty");
    expect(html).not.toContain("Power Up");
    expect(html).not.toContain("Custom Plan");
  });
});

describe("getPlanTierCopy", () => {
  test("returns tier copy including the most-popular flag and CTA", () => {
    expect(getPlanTierCopy("mighty")?.cta).toBe("Power Up");
    expect(getPlanTierCopy("super")?.mostPopular).toBe(true);
    expect(getPlanTierCopy("ultra")?.cta).toBe("Unleash Ultra");
  });

  test("returns undefined for an unknown tier key", () => {
    expect(getPlanTierCopy("nonexistent")).toBeUndefined();
  });
});
