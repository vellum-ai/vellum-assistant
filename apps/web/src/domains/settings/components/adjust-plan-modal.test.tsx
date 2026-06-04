/**
 * Tests for the credit-bundle wiring in `AdjustPlanModal` (PR 4 of the
 * pro-credit-bundles-frontend plan).
 *
 * Strategy: mock the generated API SDK so the upgrade / change-credit-tier
 * mutations resolve without network calls and we can capture the request
 * bodies. The modal's React Query reads are pre-seeded into the cache so they
 * resolve synchronously. The credit-bundle Dropdown is the design-library
 * combobox (not a native <select>): open it via its trigger, then click the
 * option whose visible label matches.
 *
 * Coverage:
 *  - upgrade (Base→Pro) forwards `credit_tier` (a selected bundle, and null for
 *    "No bundle"),
 *  - change mode (existing Pro) calls change-credit-tier with the selected
 *    value and with null on removal,
 *  - the credit UI is hidden when the catalog has no `credit_tiers`.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import * as sdkGen from "@/generated/api/sdk.gen";
import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";
import type {
  CreditTier,
  PlanListResponse,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

// ---------------------------------------------------------------------------
// Module mocks
// ---------------------------------------------------------------------------

type Captured = { body?: unknown };
let upgradeCall: Captured | null = null;
let changeCreditTierCall: Captured | null = null;
let changeMachineTierCall: Captured | null = null;
let changeStorageTierCall: Captured | null = null;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionUpgradeCreate: (opts: Captured) => {
    upgradeCall = opts;
    return Promise.resolve({ data: { status: "ok" }, response: { ok: true } });
  },
  organizationsBillingSubscriptionChangeCreditTierCreate: (opts: Captured) => {
    changeCreditTierCall = opts;
    return Promise.resolve({
      data: { status: "ok", credit_tier: null },
      response: { ok: true },
    });
  },
  organizationsBillingSubscriptionChangeMachineTierCreate: (opts: Captured) => {
    changeMachineTierCall = opts;
    return Promise.resolve({ data: { status: "ok" }, response: { ok: true } });
  },
  organizationsBillingSubscriptionChangeStorageTierCreate: (opts: Captured) => {
    changeStorageTierCall = opts;
    return Promise.resolve({ data: { status: "ok" }, response: { ok: true } });
  },
}));

// Avoid pulling the real billing-portal hook's network fan-out; the downgrade /
// portal paths are unrelated to credit-bundle wiring.
mock.module("@/domains/settings/hooks/use-billing-portal-session", () => ({
  buildPortalReturnSnapshot: () => ({}),
  formatGraceDate: () => "",
  getEffectiveCancelDate: () => null,
  useBillingPortalSession: () => ({ isPending: false, mutate: () => {} }),
}));

import { AdjustPlanModal } from "./adjust-plan-modal";

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
        id: "base",
        name: "Base",
        base_price_cents: 0,
        base_lookup_key: "base",
        billing_interval: "month",
        included_features: [],
      },
      {
        id: "pro",
        name: "Pro",
        base_price_cents: 2000,
        base_lookup_key: "pro_base",
        billing_interval: "month",
        machine_tiers: [
          {
            tier: "machine_small",
            label: "Small",
            price_cents: 1000,
            cpu: "1",
            memory: "2Gi",
          },
          {
            tier: "machine_large",
            label: "Large",
            price_cents: 3000,
            cpu: "4",
            memory: "8Gi",
          },
        ],
        storage_tiers: [
          {
            tier: "storage_10",
            label: "10 GiB",
            price_cents: 500,
            storage_gib: 10,
          },
          {
            tier: "storage_20",
            label: "20 GiB",
            price_cents: 900,
            storage_gib: 20,
          },
        ],
        included_features: [],
        ...(creditTiers ? { credit_tiers: creditTiers } : {}),
      },
    ],
  } as unknown as PlanListResponse;
}

function subscription(
  planId: "base" | "pro",
  selectedCreditTier: string | null,
): SubscriptionResponse {
  return {
    plan_id: planId,
    status: "active",
    renewal_date: null,
    current_period_end: null,
    cancel_at_period_end: false,
    cancel_at: null,
    selected_credit_tier: selectedCreditTier,
    entitlements: { managed_email: false, phone_number: false },
  } as unknown as SubscriptionResponse;
}

function renderModal(
  sub: SubscriptionResponse,
  plans: PlanListResponse,
  onTierUpgraded?: () => void,
): ReturnType<typeof render> {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  client.setQueryData(organizationsBillingSubscriptionRetrieveQueryKey(), sub);
  client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), plans);
  // Onboarding carries the current machine/storage tiers for the change flow.
  client.setQueryData(
    organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
    {
      max_machine_tier: "machine_small",
      selected_storage_tier: "storage_10",
      selected_storage_gib: 10,
    },
  );
  return render(
    <QueryClientProvider client={client}>
      <AdjustPlanModal open onClose={() => {}} onTierUpgraded={onTierUpgraded} />
    </QueryClientProvider>,
  );
}

function openCreditDropdown(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="Credit bundle"]',
  );
  if (!trigger) throw new Error("expected a Credit bundle dropdown trigger");
  fireEvent.click(trigger);
}

function openMachineDropdown(): void {
  const trigger = document.querySelector<HTMLButtonElement>(
    'button[role="combobox"][aria-label="Machine tier"]',
  );
  if (!trigger) throw new Error("expected a Machine tier dropdown trigger");
  fireEvent.click(trigger);
}

function clickOptionStartingWith(prefix: string): void {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim().startsWith(prefix));
  if (!option) throw new Error(`expected option starting with "${prefix}"`);
  fireEvent.click(option);
}

function clickOption(label: string): void {
  const option = Array.from(
    document.querySelectorAll<HTMLElement>('[role="option"]'),
  ).find((o) => o.textContent?.trim() === label);
  if (!option) throw new Error(`expected option "${label}"`);
  fireEvent.click(option);
}

beforeEach(() => {
  upgradeCall = null;
  changeCreditTierCall = null;
  changeMachineTierCall = null;
  changeStorageTierCall = null;
});

afterEach(() => {
  cleanup();
});

describe("AdjustPlanModal credit bundle — upgrade", () => {
  test("forwards the selected credit_tier in the upgrade body", async () => {
    const { getByTestId } = renderModal(
      subscription("base", null),
      proPlansResponse(CREDIT_TIERS),
    );

    openCreditDropdown();
    clickOption("50 credits — $50/mo");

    fireEvent.click(getByTestId("modal-upgrade-to-pro-button"));

    await waitFor(() => {
      if (!upgradeCall) throw new Error("upgrade not called");
    });
    expect((upgradeCall!.body as Record<string, unknown>).credit_tier).toBe(
      "credits_50",
    );
  });

  test("forwards credit_tier: null when 'No bundle' is selected (default)", async () => {
    const { getByTestId } = renderModal(
      subscription("base", null),
      proPlansResponse(CREDIT_TIERS),
    );

    fireEvent.click(getByTestId("modal-upgrade-to-pro-button"));

    await waitFor(() => {
      if (!upgradeCall) throw new Error("upgrade not called");
    });
    expect(
      (upgradeCall!.body as Record<string, unknown>).credit_tier,
    ).toBeNull();
  });
});

describe("AdjustPlanModal credit bundle — change mode", () => {
  test("calls change-credit-tier with the newly selected value", async () => {
    const { getByTestId } = renderModal(
      subscription("pro", null),
      proPlansResponse(CREDIT_TIERS),
    );

    openCreditDropdown();
    clickOption("25 credits — $25/mo");

    fireEvent.click(getByTestId("modal-change-tier-button"));

    await waitFor(() => {
      if (!changeCreditTierCall) throw new Error("change not called");
    });
    expect(
      (changeCreditTierCall!.body as Record<string, unknown>).credit_tier,
    ).toBe("credits_25");
  });

  test("calls change-credit-tier with null when removing the bundle", async () => {
    const { getByTestId } = renderModal(
      subscription("pro", "credits_50"),
      proPlansResponse(CREDIT_TIERS),
    );

    openCreditDropdown();
    clickOption("No credit bundle — $0/mo");

    fireEvent.click(getByTestId("modal-change-tier-button"));

    await waitFor(() => {
      if (!changeCreditTierCall) throw new Error("change not called");
    });
    expect(
      (changeCreditTierCall!.body as Record<string, unknown>).credit_tier,
    ).toBeNull();
  });
});

describe("AdjustPlanModal credit bundle — resize flow", () => {
  test("a credit-only change refreshes without invoking onTierUpgraded", async () => {
    let upgraded = false;
    const { getByTestId } = renderModal(
      subscription("pro", null),
      proPlansResponse(CREDIT_TIERS),
      () => {
        upgraded = true;
      },
    );

    openCreditDropdown();
    clickOption("25 credits — $25/mo");

    fireEvent.click(getByTestId("modal-change-tier-button"));

    await waitFor(() => {
      if (!changeCreditTierCall) throw new Error("change not called");
    });
    // The credit mutation fired (refresh path), but the resize flow must not.
    expect(upgraded).toBe(false);
    expect(changeMachineTierCall).toBeNull();
    expect(changeStorageTierCall).toBeNull();
  });

  test("a machine tier change still invokes onTierUpgraded", async () => {
    let upgraded = false;
    const { getByTestId } = renderModal(
      subscription("pro", null),
      proPlansResponse(CREDIT_TIERS),
      () => {
        upgraded = true;
      },
    );

    openMachineDropdown();
    // Switching from the current "Small" tier to "Large" is an upgrade, which
    // fires immediately (no downgrade reconfirm) and opens the resize flow.
    clickOptionStartingWith("Large");

    fireEvent.click(getByTestId("modal-change-tier-button"));

    await waitFor(() => {
      if (!changeMachineTierCall) throw new Error("machine change not called");
    });
    await waitFor(() => {
      if (!upgraded) throw new Error("onTierUpgraded not called");
    });
    expect(changeCreditTierCall).toBeNull();
  });
});

describe("AdjustPlanModal credit bundle — catalog gate", () => {
  test("hides the credit UI when the plan has no credit_tiers (upgrade)", () => {
    renderModal(subscription("base", null), proPlansResponse(undefined));
    expect(
      document.querySelector(
        'button[role="combobox"][aria-label="Credit bundle"]',
      ),
    ).toBeNull();
  });

  test("hides the credit UI when the plan has no credit_tiers (change)", () => {
    renderModal(subscription("pro", null), proPlansResponse(undefined));
    expect(
      document.querySelector(
        'button[role="combobox"][aria-label="Credit bundle"]',
      ),
    ).toBeNull();
  });
});
