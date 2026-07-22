/**
 * Interaction tests for the PlanCard recommended-upgrade CTA.
 *
 * Clicking "Upgrade for _ more" fires the Stripe upgrade for the recommended
 * package and redirects to the returned checkout URL — and stashes the
 * purchased package first, so the post-checkout provisioning screen shows what
 * was actually bought instead of an intent left behind by an abandoned earlier
 * checkout.
 *
 * Strategy mirrors plans-page-checkout.test.tsx: mock the generated SDK to
 * capture the upgrade body and return a redirect, and mock `openUrl` to capture
 * the redirect target. `checkout-intent` is left real — it round-trips through
 * sessionStorage, which happy-dom provides.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { MemoryRouter } from "react-router";

import * as sdkGen from "@/generated/api/sdk.gen";
import * as browserRuntime from "@/runtime/browser";
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
  saveCheckoutIntent,
} from "@/lib/billing/checkout-intent";

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

const { PlanCard } = await import("./plan-card");

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

function plansResponse(): PlanListResponse {
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
          },
        ],
      },
    ],
  };
}

function renderCard() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(
    organizationsBillingSubscriptionRetrieveQueryKey(),
    baseSubscription(),
  );
  client.setQueryData(
    organizationsBillingPlansRetrieveQueryKey(),
    plansResponse(),
  );
  return render(
    <MemoryRouter initialEntries={["/assistant/settings/usage"]}>
      <QueryClientProvider client={client}>
        <PlanCard onManage={() => {}} />
      </QueryClientProvider>
    </MemoryRouter>,
  );
}

beforeEach(() => {
  upgradeCall = null;
  openedUrl = null;
  clearCheckoutIntent();
});

afterEach(() => {
  cleanup();
  clearCheckoutIntent();
});

describe("PlanCard — recommended upgrade checkout", () => {
  test("stashes the purchased package before redirecting to Stripe", async () => {
    const { getByTestId } = renderCard();

    fireEvent.click(getByTestId("recommended-upgrade-button"));

    await waitFor(() => expect(upgradeCall).not.toBeNull());
    expect(upgradeCall!.body).toMatchObject({
      target_plan_id: "pro",
      package: "mighty",
      confirm: true,
    });

    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    expect(readCheckoutIntent()).toMatchObject({
      kind: "package",
      packageKey: "mighty",
    });
  });

  test("overwrites an intent left by an abandoned earlier checkout", async () => {
    // A previously abandoned Ultra checkout must not be what the provisioning
    // screen displays after this Mighty purchase.
    saveCheckoutIntent({ kind: "package", packageKey: "ultra" });

    const { getByTestId } = renderCard();
    fireEvent.click(getByTestId("recommended-upgrade-button"));

    await waitFor(() => expect(openedUrl).toBe(CHECKOUT_URL));
    expect(readCheckoutIntent()).toMatchObject({
      kind: "package",
      packageKey: "mighty",
    });
  });
});
