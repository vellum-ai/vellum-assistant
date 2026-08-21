/**
 * Tests for the Credits section's balance tile.
 *
 * What the tile names changes under `obscure-credits`: the wallet less the
 * credit still sitting on the usage grants, since the Plan tile's bar already
 * measures those. The summary is served from the query cache and the panel's
 * heavier siblings are stubbed, so the tile's own formatting is the only
 * moving part.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, render } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";

import * as sdkGen from "@/generated/api/sdk.gen";
import { organizationsBillingSummaryRetrieveQueryKey } from "@/generated/api/@tanstack/react-query.gen";
import type { BillingSummaryResponse } from "@/generated/api/types.gen";

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSummaryCreate: () =>
    Promise.resolve({ data: {}, response: { ok: true } }),
}));

// The siblings below the tile each pull their own billing reads and Stripe
// wiring; none of them is what this suite is about.
mock.module("@/domains/settings/components/auto-top-up-card", () => ({
  AutoTopUpCard: () => null,
}));
mock.module("@/domains/settings/components/daily-credit-limit-card", () => ({
  DAILY_CREDIT_LIMIT_ANCHOR_ID: "daily-credit-limit",
  DailyCreditLimitCard: () => null,
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
const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");

/** Drives the `obscure-credits` client flag the way the app's LD sync does. */
function setObscureCredits(value: boolean): void {
  act(() => {
    useClientFeatureFlagStore
      .getState()
      .setFlags({ obscureCredits: value }, null);
  });
}

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

function renderPanel(seed: BillingSummaryResponse) {
  const client = new QueryClient({
    defaultOptions: {
      queries: { retry: false, staleTime: Infinity, gcTime: Infinity },
    },
  });
  client.setQueryData(organizationsBillingSummaryRetrieveQueryKey(), seed);
  return render(
    <QueryClientProvider client={client}>
      <BillingPanel />
    </QueryClientProvider>,
  );
}

afterEach(() => {
  setObscureCredits(false);
  cleanup();
});

describe("BillingPanel balance tile", () => {
  test("the flag off names the whole effective balance", () => {
    const { getByTestId } = renderPanel(
      summary({
        available_usage_balance: "9.10",
        total_usage_balance: "25.00",
      }),
    );

    expect(getByTestId("effective-balance").textContent).toBe("$34.65");
  });

  test("the flag off keeps the negative rendering", () => {
    const { getByTestId } = renderPanel(
      summary({
        effective_balance: "-2.50",
        available_usage_balance: "9.10",
        total_usage_balance: "25.00",
      }),
    );

    expect(getByTestId("effective-balance").textContent).toBe("-$2.50");
  });

  describe("with obscure-credits on", () => {
    beforeEach(() => {
      setObscureCredits(true);
    });

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
});
