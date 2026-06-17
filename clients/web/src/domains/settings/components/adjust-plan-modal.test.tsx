/**
 * Tests for `AdjustPlanModal` — credit-bundle wiring, tier-change coordination,
 * and the upgrade / downgrade flows.
 *
 * Strategy: mock the generated API SDK so mutations resolve without network
 * calls and we can capture the request bodies. React Query reads are pre-seeded
 * into the cache so they resolve synchronously. The credit-bundle Dropdown is
 * the design-library combobox (not a native <select>): open it via its trigger,
 * then click the option whose visible label matches.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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
  // The onboarding query carries the current tiers. Tests that need it pre-seed
  // the cache (so this never runs). When a test deliberately leaves it unseeded
  // to exercise the error path, this rejection keeps it hermetic.
  organizationsBillingSubscriptionOnboardingRetrieve: () =>
    Promise.reject(new Error("onboarding unavailable")),
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
  overrides: Partial<SubscriptionResponse> = {},
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
    ...overrides,
  } as unknown as SubscriptionResponse;
}

type OnboardingData = {
  max_machine_tier: string;
  selected_storage_tier: string;
  selected_storage_gib: number;
};

const DEFAULT_ONBOARDING: OnboardingData = {
  max_machine_tier: "machine_small",
  selected_storage_tier: "storage_10",
  selected_storage_gib: 10,
};

function renderModal(
  sub: SubscriptionResponse,
  plans: PlanListResponse,
  onTierUpgraded?: () => void,
  onboarding: OnboardingData = DEFAULT_ONBOARDING,
): ReturnType<typeof render> & { client: QueryClient } {
  const client = new QueryClient({
    // `staleTime: Infinity` stops the pre-seeded reads from being marked stale
    // and refetched on mount. Without it, the seeded queries fire background
    // fetches: locally those hit a listening dev server (a soft 502 React Query
    // swallows while keeping the cached data), but CI is hermetic so the same
    // fetch rejects with ECONNREFUSED and the change-tier button never renders.
    defaultOptions: { queries: { retry: false, staleTime: Infinity } },
  });
  client.setQueryData(organizationsBillingSubscriptionRetrieveQueryKey(), sub);
  client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), plans);
  // Onboarding carries the current machine/storage tiers for the change flow.
  client.setQueryData(
    organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
    onboarding,
  );
  const result = render(
    <QueryClientProvider client={client}>
      <AdjustPlanModal open onClose={() => {}} onTierUpgraded={onTierUpgraded} />
    </QueryClientProvider>,
  );
  return { ...result, client };
}

function getDropdownTrigger(label: string): HTMLButtonElement {
  const trigger = document.querySelector<HTMLButtonElement>(
    `button[role="combobox"][aria-label="${label}"]`,
  );
  if (!trigger) throw new Error(`expected a ${label} dropdown trigger`);
  return trigger;
}

function openCreditDropdown(): void {
  fireEvent.click(getDropdownTrigger("Credit bundle"));
}

function openMachineDropdown(): void {
  fireEvent.click(getDropdownTrigger("Machine tier"));
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

describe("AdjustPlanModal credit bundle — unseeded sentinel", () => {
  test("does not enable Update Plan from a spurious pre-seed creditChanged", async () => {
    // A Pro user with an existing bundle and no other pending change. Once the
    // seed effect lands, selectedCreditTier equals currentCreditTier, so no
    // dimension changed and the CTA stays disabled. The unseeded `undefined`
    // sentinel must never read as a credit diff vs. the existing bundle.
    const { getByTestId } = renderModal(
      subscription("pro", "credits_50"),
      proPlansResponse(CREDIT_TIERS),
    );

    await waitFor(() => {
      const trigger = document.querySelector(
        'button[role="combobox"][aria-label="Credit bundle"]',
      );
      if (!trigger) throw new Error("picker not rendered yet");
    });

    const button = getByTestId("modal-change-tier-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
  });

  test("does not send credit_tier: null before the user changes anything", async () => {
    // Even if the CTA were clicked, no credit mutation should fire because the
    // seeded selection matches the current bundle. Guards against the pre-seed
    // `null` removing a paid bundle without intent.
    const { getByTestId } = renderModal(
      subscription("pro", "credits_50"),
      proPlansResponse(CREDIT_TIERS),
    );

    await waitFor(() => {
      const trigger = document.querySelector(
        'button[role="combobox"][aria-label="Credit bundle"]',
      );
      if (!trigger) throw new Error("picker not rendered yet");
    });

    fireEvent.click(getByTestId("modal-change-tier-button"));

    // Give any (erroneous) mutation a tick to fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(changeCreditTierCall).toBeNull();
  });

  test("a current bundle absent from the catalog does not enable a spurious removal", async () => {
    // A Pro user holds a deprecated tier (`credits_legacy`) that the live
    // catalog no longer advertises. Opening the modal must NOT coerce that into
    // a "remove bundle" pending change: the Update Plan CTA stays disabled and
    // clicking it submits no credit mutation (which would have sent
    // `credit_tier: null`, silently dropping the user's paid bundle).
    const { getByTestId } = renderModal(
      subscription("pro", "credits_legacy"),
      proPlansResponse(CREDIT_TIERS),
    );

    await waitFor(() => {
      const trigger = document.querySelector(
        'button[role="combobox"][aria-label="Credit bundle"]',
      );
      if (!trigger) throw new Error("picker not rendered yet");
    });

    const button = getByTestId("modal-change-tier-button") as HTMLButtonElement;
    expect(button.disabled).toBe(true);

    fireEvent.click(button);
    // Give any (erroneous) mutation a tick to fire.
    await new Promise((r) => setTimeout(r, 0));
    expect(changeCreditTierCall).toBeNull();
  });

  test("preserves a held legacy bundle across a plans refetch when applying an unrelated change", async () => {
    // A Pro user holds a deprecated tier (`credits_legacy`) absent from the
    // catalog. The first seed preserves it. A mid-modal plans refetch re-runs
    // the seeding effect with `prev` = the legacy tier; since it equals the
    // current bundle it must be KEPT (not coerced to null). Applying an
    // unrelated machine change must then send only the machine mutation and
    // never `credit_tier: null` — which would silently drop the paid bundle.
    const { getByTestId, client } = renderModal(
      subscription("pro", "credits_legacy"),
      proPlansResponse(CREDIT_TIERS),
    );

    await waitFor(() => {
      const trigger = document.querySelector(
        'button[role="combobox"][aria-label="Credit bundle"]',
      );
      if (!trigger) throw new Error("picker not rendered yet");
    });

    // Simulate a mid-modal refetch: re-seed by replacing the plans object so the
    // seeding effect re-runs with `prev` = credits_legacy (held, not in catalog).
    // React Query's structural sharing keeps the cached object's reference when
    // the payload is deep-equal, so we mutate an unrelated field (the Pro plan
    // name) to force a fresh `proPlan` identity that re-triggers the effect.
    // Tiers (machine/storage/credit) stay identical so only the credit re-seed
    // is under test. With the bug, `prev` would be coerced to null here, marking
    // creditChanged and queuing a spurious `credit_tier: null`.
    const refetched = proPlansResponse(CREDIT_TIERS);
    refetched.plans[1]!.name = "Pro (refetched)";
    await act(async () => {
      client.setQueryData(organizationsBillingPlansRetrieveQueryKey(), refetched);
      await new Promise((r) => setTimeout(r, 0));
    });

    // Make an unrelated machine change so the CTA enables via that dimension.
    openMachineDropdown();
    clickOptionStartingWith("Large");

    fireEvent.click(getByTestId("modal-change-tier-button"));

    await waitFor(() => {
      if (!changeMachineTierCall) throw new Error("machine change not called");
    });
    expect(
      (changeMachineTierCall!.body as Record<string, unknown>).machine_tier,
    ).toBe("machine_large");
    // The held legacy bundle must survive the refetch: no credit mutation fires.
    await new Promise((r) => setTimeout(r, 0));
    expect(changeCreditTierCall).toBeNull();
  });

  test("preserves an explicit 'No bundle' choice across a plans refetch", async () => {
    // Pro user with credits_50 picks "No credit bundle" (selection becomes
    // null). A subsequent plans refetch re-runs the seeding effect; the explicit
    // null must NOT be coalesced back to the existing bundle.
    const { getByTestId, client } = renderModal(
      subscription("pro", "credits_50"),
      proPlansResponse(CREDIT_TIERS),
    );

    await waitFor(() => {
      const trigger = document.querySelector(
        'button[role="combobox"][aria-label="Credit bundle"]',
      );
      if (!trigger) throw new Error("picker not rendered yet");
    });

    openCreditDropdown();
    clickOption("No credit bundle — $0/mo");

    // Simulate a mid-modal refetch: re-seed by replacing the plans object so the
    // seeding effect re-runs with a fresh `proPlan` identity.
    client.setQueryData(
      organizationsBillingPlansRetrieveQueryKey(),
      proPlansResponse(CREDIT_TIERS),
    );

    // The pending removal must survive the re-seed.
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

describe("AdjustPlanModal credit bundle — headline total", () => {
  test("upgrade total includes the selected bundle's monthly price", async () => {
    // Base→Pro. Defaults: base $20 + Small machine $10 + 10 GiB storage $5 =
    // $35/mo with no bundle. Picking the $50 bundle must add $50 → $85/mo.
    const { getByTestId } = renderModal(
      subscription("base", null),
      proPlansResponse(CREDIT_TIERS),
    );

    await waitFor(() => {
      if (getByTestId("modal-pro-price").textContent?.includes("$35/mo"))
        return;
      throw new Error("base total not rendered yet");
    });

    openCreditDropdown();
    clickOption("50 credits — $50/mo");

    await waitFor(() => {
      if (getByTestId("modal-pro-price").textContent?.includes("$85/mo"))
        return;
      throw new Error("total did not include the selected bundle");
    });
  });

  test("change-mode total and delta reflect swapping bundles", async () => {
    // Pro with no current bundle. Current = base $20 + Small $10 + 10 GiB $5 =
    // $35/mo. Picking the $25 bundle makes the new total $60/mo (+$25 delta).
    const { getByTestId } = renderModal(
      subscription("pro", null),
      proPlansResponse(CREDIT_TIERS),
    );

    await waitFor(() => {
      if (getByTestId("modal-pro-price").textContent?.includes("$35/mo"))
        return;
      throw new Error("current total not rendered yet");
    });

    openCreditDropdown();
    clickOption("25 credits — $25/mo");

    await waitFor(() => {
      const text = getByTestId("modal-pro-price").textContent ?? "";
      if (text.includes("$60/mo") && text.includes("+$25/mo")) return;
      throw new Error("total/delta did not reflect the swapped bundle");
    });
  });
});

describe("AdjustPlanModal Pro header total — no picker shown", () => {
  test("a cancellation-pending Pro card shows the current total, not the cheapest seeded one", async () => {
    // A current Pro subscriber with a pending cancellation: no tier picker
    // renders (only the "Keep your Plan" reactivation CTA). The header must show
    // the user's CURRENT total, not the cheapest seeded total. Current tiers are
    // deliberately more expensive than the cheapest so the two are observably
    // different: base $20 + Large machine $30 + 20 GiB storage $9 = $59/mo,
    // versus the cheapest base $20 + Small $10 + 10 GiB $5 = $35/mo.
    const { getByTestId, queryByTestId } = renderModal(
      subscription("pro", null, { cancel_at_period_end: true }),
      proPlansResponse(CREDIT_TIERS),
      undefined,
      {
        max_machine_tier: "machine_large",
        selected_storage_tier: "storage_20",
        selected_storage_gib: 20,
      },
    );

    await waitFor(() => {
      const text = getByTestId("modal-pro-price").textContent ?? "";
      if (text.includes("Currently") && text.includes("$59/mo")) return;
      throw new Error("current total not rendered yet");
    });

    const text = getByTestId("modal-pro-price").textContent ?? "";
    expect(text).not.toContain("$35/mo");

    // No tier picker and no "Update Plan" button render in this flow.
    expect(
      document.querySelector('button[role="combobox"][aria-label="Machine tier"]'),
    ).toBeNull();
    expect(queryByTestId("modal-change-tier-button")).toBeNull();
    expect(queryByTestId("modal-upgrade-to-pro-button")).toBeNull();
  });

  test("a current Pro card shows a distinct fallback (not a perpetual spinner, not the cheapest price) when onboarding errors", async () => {
    // A cancellation-pending Pro subscriber whose onboarding query errors (so
    // the current total is never available). The header must NOT fall back to
    // the cheapest seeded `From $35/mo` (it understates what the subscriber
    // pays), and must NOT show a perpetual "Loading your plan..." spinner for a
    // settled error — it shows a distinct "pricing unavailable" fallback.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: Infinity } },
    });
    client.setQueryData(
      organizationsBillingSubscriptionRetrieveQueryKey(),
      subscription("pro", null, { cancel_at_period_end: true }),
    );
    client.setQueryData(
      organizationsBillingPlansRetrieveQueryKey(),
      proPlansResponse(CREDIT_TIERS),
    );
    // Deliberately leave the onboarding query unseeded: it fires, the mocked
    // SDK fn rejects, and with retry:false it settles into an error state.
    const { findByTestId, queryByText, queryByTestId } = render(
      <QueryClientProvider client={client}>
        <AdjustPlanModal open onClose={() => {}} />
      </QueryClientProvider>,
    );

    // Settled error → distinct fallback, not the infinite spinner.
    await findByTestId("modal-pro-price-unavailable");
    expect(queryByText("Loading your plan...")).toBeNull();

    // The cheapest fallback price must never render for a current Pro card.
    const price = queryByTestId("modal-pro-price");
    expect(price).toBeNull();
  });

  test("a current Pro card whose held bundle is no longer in the catalog shows unavailable, not an understated Currently total", async () => {
    // A cancellation-pending Pro subscriber holding a bundle that the live
    // catalog no longer lists. `priceForCredit` can't resolve its price (0), so
    // the authoritative no-picker "Currently $X" would understate what the user
    // pays. With onboarding fully resolved (so machine/storage are known), the
    // header must show the "unavailable" fallback rather than a wrong, lower
    // "Currently $X".
    const { findByTestId, queryByTestId } = renderModal(
      subscription("pro", "credits_legacy", { cancel_at_period_end: true }),
      proPlansResponse(CREDIT_TIERS),
      undefined,
      {
        max_machine_tier: "machine_large",
        selected_storage_tier: "storage_20",
        selected_storage_gib: 20,
      },
    );

    await findByTestId("modal-pro-price-unavailable");
    // No authoritative price is shown when the held bundle isn't priceable.
    expect(queryByTestId("modal-pro-price")).toBeNull();
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

// ---------------------------------------------------------------------------
// Multi-dimension coordination tests
// ---------------------------------------------------------------------------

const LARGE_MACHINE_ONBOARDING: OnboardingData = {
  max_machine_tier: "machine_large",
  selected_storage_tier: "storage_10",
  selected_storage_gib: 10,
};

function openStorageDropdown(): void {
  fireEvent.click(getDropdownTrigger("Storage tier"));
}

describe("AdjustPlanModal — multi-dimension tier coordination", () => {
  test("storage upgrade + machine downgrade still triggers onTierUpgraded", async () => {
    // Regression test: the original consolidated handler gated onTierUpgraded
    // on !isMachineDowngrade globally, which blocked resize for a concurrent
    // storage upgrade when the machine was being downgraded.
    let upgraded = false;
    const { getByTestId } = renderModal(
      subscription("pro", null),
      proPlansResponse(CREDIT_TIERS),
      () => {
        upgraded = true;
      },
      LARGE_MACHINE_ONBOARDING,
    );

    // Downgrade machine: Large → Small
    openMachineDropdown();
    clickOptionStartingWith("Small");

    // Upgrade storage: 10 GiB → 20 GiB
    openStorageDropdown();
    clickOptionStartingWith("20 GiB");

    // Machine downgrade opens the reconfirm modal first.
    fireEvent.click(getByTestId("modal-change-tier-button"));

    // Confirm the downgrade in the reconfirm modal.
    await waitFor(() => {
      const btn = document.querySelector<HTMLButtonElement>(
        '[data-testid="confirm-downgrade-button"]',
      );
      if (!btn) throw new Error("reconfirm not open");
      fireEvent.click(btn);
    });

    // Both mutations should fire.
    await waitFor(() => {
      if (!changeMachineTierCall) throw new Error("machine change not called");
      if (!changeStorageTierCall) throw new Error("storage change not called");
    });

    // The storage upgrade must trigger the resize flow even though the machine
    // change is a downgrade.
    await waitFor(() => {
      if (!upgraded) throw new Error("onTierUpgraded not called");
    });
  });

  test("machine upgrade + credit change fires both mutations, only machine triggers resize", async () => {
    let upgraded = false;
    const { getByTestId } = renderModal(
      subscription("pro", null),
      proPlansResponse(CREDIT_TIERS),
      () => {
        upgraded = true;
      },
    );

    // Upgrade machine: Small → Large
    openMachineDropdown();
    clickOptionStartingWith("Large");

    // Add a credit bundle
    openCreditDropdown();
    clickOption("25 credits — $25/mo");

    fireEvent.click(getByTestId("modal-change-tier-button"));

    await waitFor(() => {
      if (!changeMachineTierCall) throw new Error("machine change not called");
      if (!changeCreditTierCall) throw new Error("credit change not called");
    });

    // Machine upgrade triggers resize flow.
    await waitFor(() => {
      if (!upgraded) throw new Error("onTierUpgraded not called");
    });
  });
});

describe("AdjustPlanModal credit bundle — '*Credits not included' note", () => {
  test("omits the note on the Pro card when credit_tiers are available", () => {
    const { queryByTestId } = renderModal(
      subscription("base", null),
      proPlansResponse(CREDIT_TIERS),
    );
    expect(queryByTestId("modal-credits-not-included")).toBeNull();
  });

  test("shows the note on the Pro card when no credit_tiers are available", () => {
    const { queryByTestId } = renderModal(
      subscription("base", null),
      proPlansResponse(undefined),
    );
    expect(queryByTestId("modal-credits-not-included")).not.toBeNull();
  });
});

describe("AdjustPlanModal credit bundle — selector order", () => {
  function creditAndMachineTriggers(): {
    credit: HTMLButtonElement;
    machine: HTMLButtonElement;
  } {
    return {
      credit: getDropdownTrigger("Credit bundle"),
      machine: getDropdownTrigger("Machine tier"),
    };
  }

  test("renders the credit bundle picker before the machine tier (upgrade)", () => {
    renderModal(subscription("base", null), proPlansResponse(CREDIT_TIERS));
    const { credit, machine } = creditAndMachineTriggers();
    expect(
      credit.compareDocumentPosition(machine) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });

  test("renders the credit bundle picker before the machine tier (change)", () => {
    renderModal(subscription("pro", null), proPlansResponse(CREDIT_TIERS));
    const { credit, machine } = creditAndMachineTriggers();
    expect(
      credit.compareDocumentPosition(machine) &
        Node.DOCUMENT_POSITION_FOLLOWING,
    ).toBeTruthy();
  });
});
