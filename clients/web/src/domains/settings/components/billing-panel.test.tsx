/**
 * Tests for the Credits section's balance tile.
 *
 * The tile names the wallet less the credit still sitting on the usage
 * grants, since the Plan tile's bar already measures those. The summary is
 * served from the query cache and the panel's heavier siblings are stubbed,
 * so the tile's own formatting is the only moving part.
 *
 * The unseeded case covers the loading branch: a shimmer tile the same height
 * as the resolved one, with no spinner and no "Loading" copy, and the rest of
 * the card still mounted around it.
 */

import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import * as sdkGen from "@/generated/api/sdk.gen";
import { organizationsBillingSummaryRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { BillingSummaryResponse } from "@/generated/api/types.gen";

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSummaryCreate: () =>
    Promise.resolve({ data: {}, response: { ok: true } }),
  // Never settles: the seeded cases are fresh forever (`staleTime: Infinity`)
  // so they never call this, and the unseeded case wants to stay loading.
  organizationsBillingSummaryRetrieve: () => new Promise(() => {}),
}));

// The siblings below the tile each pull their own billing reads and Stripe
// wiring; none of them is what this suite is about. They render a marker so
// the loading case can prove they are mounted alongside the pending summary.
mock.module("@/domains/settings/components/auto-top-up-card", () => ({
  AutoTopUpCard: () => <div data-testid="auto-top-up-card-stub" />,
}));
mock.module("@/domains/settings/components/daily-credit-limit-card", () => ({
  DAILY_CREDIT_LIMIT_ANCHOR_ID: "daily-credit-limit",
  DailyCreditLimitCard: () => (
    <div data-testid="daily-credit-limit-card-stub" />
  ),
}));
mock.module("@/domains/settings/components/low-balance-alert-card", () => ({
  LowBalanceAlertCard: () => null,
}));
mock.module("@/domains/settings/components/referral-modal", () => ({
  ReferralModal: () => null,
}));
mock.module("@/components/add-credits-modal", () => ({
  AddCreditsModal: () => null,
}));

const { BillingPanel } = await import("./billing-panel");

function summary(
  overrides: Partial<BillingSummaryResponse> = {},
): BillingSummaryResponse {
  return {
    settled_balance: "34.65",
    minimum_top_up: "5.00",
    maximum_top_up: "100.00",
    maximum_balance: "500.00",
    allowed_top_up_amounts: ["5.00", "10.00", "25.00"],
    settled_balance_usd: "34.65",
    minimum_top_up_usd: "5.00",
    maximum_top_up_usd: "100.00",
    maximum_balance_usd: "500.00",
    pending_compute: "0.00",
    pending_compute_usd: "0.00",
    effective_balance: "34.65",
    effective_balance_usd: "34.65",
    is_degraded: false,
    daily_credit_limit_usd: null,
    daily_spend_usd: "0.00",
    daily_limit_reached: false,
    daily_limit_snoozed: false,
    low_balance_threshold_usd: "5.00",
    low_balance_warning: false,
    credits_expiring_soon_usd: "0.00",
    next_credit_expiry_at: null,
    ...overrides,
  };
}

/** Omit `seed` to leave the cache empty, which holds the summary pending. */
function renderPanel(seed?: BillingSummaryResponse) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  if (seed) {
    client.setQueryData(organizationsBillingSummaryRetrieveQueryKey(), seed);
  }
  return render(
    <QueryClientProvider client={client}>
      <BillingPanel />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  cleanup();
});

describe("BillingPanel while loading", () => {
  test("swaps only the balance for shimmer, with no spinner or loading copy", () => {
    const { container, getByTestId, queryByTestId } = renderPanel();

    expect(getByTestId("billing-panel-balance-skeleton")).not.toBeNull();
    expect(queryByTestId("effective-balance")).toBeNull();
    expect(container.textContent).not.toContain("Loading");
    // The header the real panel paints from the first frame, so the swap
    // keeps its title and subtitle in place.
    expect(container.textContent).toContain("Extra Usage Credits");
  });

  test("keeps the rest of the card mounted while the summary is pending", () => {
    // The nested cards each run their own read, so they have to mount now
    // rather than behind this one; the deep-link anchor they hang under has
    // to be in the document for the same reason.
    const { container, getByTestId, queryByTestId } = renderPanel();

    expect(queryByTestId("auto-top-up-card-stub")).not.toBeNull();
    expect(queryByTestId("daily-credit-limit-card-stub")).not.toBeNull();
    expect(container.querySelector("#daily-credit-limit")).not.toBeNull();
    expect(container.textContent).toContain("Custom Low Balance Alert");
    // Earning credits asks nothing of the summary, so it stays usable; adding
    // them needs the top-up bounds it carries.
    const earn = getByTestId("earn-credits-button") as HTMLButtonElement;
    expect(earn.disabled).toBe(false);
    const add = getByTestId("add-credits-button") as HTMLButtonElement;
    expect(add.disabled).toBe(true);
  });

  test("announces the wait it is standing in for", () => {
    // The panel loads on its own inside the settled tab, where nothing else
    // announces the wait. The tab's own skeleton stack mounts the whole-card
    // stand-in instead and announces that once.
    const { container } = renderPanel();

    const announced = container.querySelectorAll('[role="status"]');
    expect(announced.length).toBe(1);
    expect(announced[0]?.getAttribute("aria-label")).toBe(
      "Loading credit balance",
    );
  });
});

describe("BillingPanel balance tile", () => {
  test("names only the credit held on top of the usage grants", () => {
    const { getByTestId } = renderPanel(
      summary({
        available_usage_balance: "9.10",
        total_usage_balance: "25.00",
      }),
    );

    expect(getByTestId("effective-balance").textContent).toBe("$25.55");
  });

  test("clamps at zero when the grants cover the whole balance", () => {
    const { getByTestId } = renderPanel(
      summary({
        effective_balance: "5.00",
        available_usage_balance: "9.10",
        total_usage_balance: "25.00",
      }),
    );

    expect(getByTestId("effective-balance").textContent).toBe("$0");
  });

  test("a platform reporting no grant figure keeps today's number", () => {
    const { getByTestId } = renderPanel(summary());

    expect(getByTestId("effective-balance").textContent).toBe("$34.65");
  });

  test("a platform reporting no grant figure keeps the negative rendering", () => {
    const { getByTestId } = renderPanel(
      summary({ effective_balance: "-2.50" }),
    );

    expect(getByTestId("effective-balance").textContent).toBe("-$2.50");
  });

  test("an overdrawn wallet has no extra credit to name", () => {
    const { getByTestId } = renderPanel(
      summary({
        effective_balance: "-2.50",
        available_usage_balance: "0.00",
        total_usage_balance: "25.00",
      }),
    );

    expect(getByTestId("effective-balance").textContent).toBe("$0");
  });
});
