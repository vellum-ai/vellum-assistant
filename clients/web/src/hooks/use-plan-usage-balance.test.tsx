/**
 * Tests for the Plan section's usage-balance reading.
 *
 * The hook only speaks when every input is trustworthy: the `obscure-credits`
 * flag on, and either a Pro sub with a positive included-credit amount and a
 * settled totals read, or a free plan whose platform reports both usage-grant
 * figures. Most of these assert the null cases that keep a wrong number off
 * the card.
 * `includedMonthlyCreditsUsd` is the pure half that resolves the Pro
 * denominator, from a clean pin's stock package or from the credit tier a
 * Custom sub holds; `usageGrantRatio` is the pure half that resolves the free
 * one, off the billing summary alone. The usage endpoint is driven from the
 * SDK boundary, mirroring the other billing hook tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type {
  PlanListResponse,
  ProPackage,
  ProPlan,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

let totalsQuery: Record<string, string> | undefined;
let totalsCalls = 0;
let totalsUsd = "12.50";
let totalsShouldFail = false;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingUsageTotalsRetrieve: (opts: {
    query?: Record<string, string>;
  }) => {
    totalsCalls += 1;
    totalsQuery = opts.query;
    if (totalsShouldFail) {
      return Promise.reject(new Error("totals unavailable"));
    }
    return Promise.resolve({
      data: { total_usd: totalsUsd, event_count: 3 },
      response: { ok: true },
    });
  },
}));

const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");
const {
  includedMonthlyCreditsUsd,
  includedMonthlyCreditsUsdFromPlans,
  usePlanUsageBalance,
  utcMonthBefore,
  usageGrantRatio,
} = await import("./use-plan-usage-balance");

function setObscureCredits(value: boolean): void {
  act(() => {
    useClientFeatureFlagStore
      .getState()
      .setFlags({ obscureCredits: value }, null);
  });
}

function mightyPackage(creditsUsd: number | null): ProPackage {
  return {
    key: "mighty",
    name: "Mighty",
    machine_size: null,
    credits_usd: creditsUsd,
    storage_gib: 10,
  } as ProPackage;
}

function proSubscription(
  over: Partial<SubscriptionResponse> = {},
): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_start: null,
    current_period_end: "2026-08-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    package: { key: "mighty", name: "Mighty", version: 1, customized: false },
    entitlements: { managed_email: false, phone_number: false },
    ...over,
  };
}

/** A free (base) sub: no package, no bundle, and no cycle to measure. */
function freeSubscription(
  over: Partial<SubscriptionResponse> = {},
): SubscriptionResponse {
  return proSubscription({
    plan_id: "base",
    package: null,
    current_period_end: null,
    ...over,
  });
}

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={client}>{children}</QueryClientProvider>
  );
}

function renderBalance(args: {
  subscription: SubscriptionResponse | undefined;
  includedCreditsUsd: number | null;
  availableUsageBalance?: string | null;
  totalUsageBalance?: string | null;
}) {
  return renderHook(() => usePlanUsageBalance(args), { wrapper: wrapper() });
}

beforeEach(() => {
  totalsQuery = undefined;
  totalsCalls = 0;
  totalsUsd = "12.50";
  totalsShouldFail = false;
  setObscureCredits(true);
});

afterEach(() => {
  setObscureCredits(false);
});

describe("usePlanUsageBalance", () => {
  test("reports spend against the included credits", async () => {
    const { result } = renderBalance({
      subscription: proSubscription(),
      includedCreditsUsd: 25,
    });

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(result.current?.ratio).toBeCloseTo(0.5, 6);
    expect(result.current?.resetsAt).toBe("2026-08-10T00:00:00Z");
  });

  test("clamps an overspent cycle to a full bar", async () => {
    totalsUsd = "80";
    const { result } = renderBalance({
      subscription: proSubscription(),
      includedCreditsUsd: 25,
    });

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(result.current?.ratio).toBe(1);
  });

  test("derives the cycle start by subtracting a month from the end", async () => {
    const { result } = renderBalance({
      subscription: proSubscription(),
      includedCreditsUsd: 25,
    });

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(totalsQuery?.["from"]).toBe("2026-07-10");
    // The endpoint is asked for the org's own totals, unfiltered.
    expect(totalsQuery?.["tz"]).toBeUndefined();
    expect(totalsQuery?.["usage_source"]).toBeUndefined();
  });

  test("prefers the reported cycle start when the platform sends one", async () => {
    const { result } = renderBalance({
      subscription: proSubscription({
        current_period_start: "2026-07-14T09:30:00Z",
      }),
      includedCreditsUsd: 25,
    });

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(totalsQuery?.["from"]).toBe("2026-07-14");
  });

  test("stays silent while the flag is off", async () => {
    setObscureCredits(false);
    const { result } = renderBalance({
      subscription: proSubscription(),
      includedCreditsUsd: 25,
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
    expect(totalsCalls).toBe(0);
  });

  test("stays silent on a base plan", async () => {
    const { result } = renderBalance({
      subscription: proSubscription({ plan_id: "base", package: null }),
      includedCreditsUsd: null,
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
    expect(totalsCalls).toBe(0);
  });

  test("stays silent when no included-credit amount is resolvable", async () => {
    const { result } = renderBalance({
      subscription: proSubscription(),
      includedCreditsUsd: null,
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
    expect(totalsCalls).toBe(0);
  });

  test("stays silent when the totals read fails", async () => {
    totalsShouldFail = true;
    const { result } = renderBalance({
      subscription: proSubscription(),
      includedCreditsUsd: 25,
    });

    await waitFor(() => {
      expect(totalsCalls).toBeGreaterThan(0);
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
  });
});

describe("usageGrantRatio", () => {
  test("the used share of what was granted", () => {
    // $5.00 granted with $1.60 unused: $3.40 of it is gone.
    expect(usageGrantRatio(5, 1.6)).toBeCloseTo(0.68, 6);
  });

  test("a further grant lowers the reading", () => {
    // The same $3.40 used, now against a $10.00 total.
    expect(usageGrantRatio(10, 6.6)).toBeCloseTo(0.34, 6);
  });

  test("a grant with nothing left is exactly a full bar", () => {
    expect(usageGrantRatio(5, 0)).toBe(1);
  });

  test("an untouched grant reads empty", () => {
    expect(usageGrantRatio(5, 5)).toBe(0);
  });

  test("more unused than granted clamps rather than going negative", () => {
    expect(usageGrantRatio(5, 6)).toBe(0);
  });

  test("an account that was never granted credit has no reading", () => {
    expect(usageGrantRatio(0, 0)).toBeNull();
  });

  test("a platform reporting neither figure has no reading", () => {
    expect(usageGrantRatio(null, 1.6)).toBeNull();
    expect(usageGrantRatio(5, null)).toBeNull();
    expect(usageGrantRatio(null, null)).toBeNull();
  });
});

describe("usePlanUsageBalance on a free plan", () => {
  test("measures the used share of the usage grants", async () => {
    const { result } = renderBalance({
      subscription: freeSubscription(),
      includedCreditsUsd: null,
      totalUsageBalance: "5.00",
      availableUsageBalance: "1.60",
    });

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(result.current?.kind).toBe("wallet");
    expect(result.current?.ratio).toBeCloseTo(0.68, 6);
    // Nothing resets on a free plan, so the panel has no date to quote.
    expect(result.current?.resetsAt).toBeNull();
  });

  test("never asks the usage endpoint for a window", async () => {
    const { result } = renderBalance({
      subscription: freeSubscription(),
      includedCreditsUsd: null,
      totalUsageBalance: "5.00",
      availableUsageBalance: "1.60",
    });

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    // The whole reading comes off the billing summary the caller already
    // holds, so there is no second read to pay for.
    expect(totalsCalls).toBe(0);
  });

  test("a further grant lowers the reading", async () => {
    const { result } = renderBalance({
      subscription: freeSubscription(),
      includedCreditsUsd: null,
      totalUsageBalance: "10.00",
      availableUsageBalance: "6.60",
    });

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(result.current?.ratio).toBeCloseTo(0.34, 6);
  });

  test("a fully used grant reads as a full bar", async () => {
    const { result } = renderBalance({
      subscription: freeSubscription(),
      includedCreditsUsd: null,
      totalUsageBalance: "5.00",
      availableUsageBalance: "0.00",
    });

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(result.current?.ratio).toBe(1);
  });

  test("an account that was never granted credit has no bar", async () => {
    const { result } = renderBalance({
      subscription: freeSubscription(),
      includedCreditsUsd: null,
      totalUsageBalance: "0.00",
      availableUsageBalance: "0.00",
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
  });

  test("stays silent while the flag is off", async () => {
    setObscureCredits(false);
    const { result } = renderBalance({
      subscription: freeSubscription(),
      includedCreditsUsd: null,
      totalUsageBalance: "5.00",
      availableUsageBalance: "1.60",
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
    expect(totalsCalls).toBe(0);
  });

  test("stays silent before the summary lands", async () => {
    const { result } = renderBalance({
      subscription: freeSubscription(),
      includedCreditsUsd: null,
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
    expect(totalsCalls).toBe(0);
  });

  test("stays silent when the platform reports only one figure", async () => {
    // An older self-hosted platform omits both; a partial read is no more
    // usable than none.
    const { result } = renderBalance({
      subscription: freeSubscription(),
      includedCreditsUsd: null,
      totalUsageBalance: "5.00",
      availableUsageBalance: null,
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
  });
});

describe("includedMonthlyCreditsUsd", () => {
  const proPlan = {
    id: "pro",
    credit_tiers: [
      { tier: "credits_45", label: "45 credits", credits_usd: 45 },
      { tier: "credits_50", label: "50 credits", credits_usd: 50 },
    ],
  } as unknown as ProPlan;

  /** A customized (Custom) Pro sub, which matches no stock package. */
  function customSub(tier: string | null): SubscriptionResponse {
    return proSubscription({
      package: { key: "mighty", name: "Mighty", version: 1, customized: true },
      selected_credit_tier: tier,
    });
  }

  test("a clean pin's stock bundle wins over the held tier", () => {
    // The pin states the bundle outright, so the tier is never consulted, even
    // when it would price differently.
    expect(
      includedMonthlyCreditsUsd(
        proSubscription({ selected_credit_tier: "credits_50" }),
        mightyPackage(25),
        proPlan,
      ),
    ).toBe(25);
  });

  test("a Custom sub is priced from its credit tier in the catalog", () => {
    expect(
      includedMonthlyCreditsUsd(customSub("credits_45"), null, proPlan),
    ).toBe(45);
  });

  test("a tier the catalog dropped falls back to the amount in its key", () => {
    // A grandfathered tier is absent from the catalog, but the org still pays
    // for it, so the `credits_<usd>` key carries the amount.
    expect(
      includedMonthlyCreditsUsd(customSub("credits_25"), null, proPlan),
    ).toBe(25);
  });

  test("an unpinned sub is priced from its tier the same way", () => {
    expect(
      includedMonthlyCreditsUsd(
        proSubscription({ package: null, selected_credit_tier: "credits_45" }),
        null,
        proPlan,
      ),
    ).toBe(45);
  });

  test("no credit tier means no denominator", () => {
    expect(
      includedMonthlyCreditsUsd(customSub(null), null, proPlan),
    ).toBeNull();
  });

  test("an unparseable tier key means no denominator", () => {
    expect(
      includedMonthlyCreditsUsd(customSub("legacy_bundle"), null, proPlan),
    ).toBeNull();
  });

  test("a zero-credit bundle means no denominator", () => {
    const freeBundle = {
      id: "pro",
      credit_tiers: [{ tier: "credits_0", label: "None", credits_usd: 0 }],
    } as unknown as ProPlan;
    expect(
      includedMonthlyCreditsUsd(customSub("credits_0"), null, freeBundle),
    ).toBeNull();
    expect(
      includedMonthlyCreditsUsd(proSubscription(), mightyPackage(0), proPlan),
    ).toBeNull();
  });

  test("a clean pin with no bundle falls through to the held tier", () => {
    expect(
      includedMonthlyCreditsUsd(
        proSubscription({ selected_credit_tier: "credits_50" }),
        mightyPackage(null),
        proPlan,
      ),
    ).toBe(50);
  });

  test("prices a Custom sub even with no catalog in hand", () => {
    // The plans query has not landed yet, or the catalog carries no credit
    // tiers; the key still says what the sub holds.
    expect(includedMonthlyCreditsUsd(customSub("credits_45"), null, null)).toBe(
      45,
    );
  });

  test("a base plan never has a bar", () => {
    expect(
      includedMonthlyCreditsUsd(
        proSubscription({ plan_id: "base", package: null }),
        null,
        proPlan,
      ),
    ).toBeNull();
  });

  test("an absent subscription never has a bar", () => {
    expect(includedMonthlyCreditsUsd(undefined, null, proPlan)).toBeNull();
  });
});

describe("includedMonthlyCreditsUsdFromPlans", () => {
  const plans = [
    { id: "base", name: "Free" },
    {
      id: "pro",
      packages: [{ ...mightyPackage(25), version: 1 }],
      credit_tiers: [
        { tier: "credits_45", label: "45 credits", credits_usd: 45 },
      ],
    },
  ] as unknown as PlanListResponse["plans"];

  test("a clean pin is priced from the catalog package it names", () => {
    expect(includedMonthlyCreditsUsdFromPlans(proSubscription(), plans)).toBe(
      25,
    );
  });

  test("a customized pin matches no package and falls to its tier", () => {
    expect(
      includedMonthlyCreditsUsdFromPlans(
        proSubscription({
          package: {
            key: "mighty",
            name: "Mighty",
            version: 1,
            customized: true,
          },
          selected_credit_tier: "credits_45",
        }),
        plans,
      ),
    ).toBe(45);
  });

  test("a pin on a version the catalog dropped has no stock bundle", () => {
    expect(
      includedMonthlyCreditsUsdFromPlans(
        proSubscription({
          package: {
            key: "mighty",
            name: "Mighty",
            version: 2,
            customized: false,
          },
        }),
        plans,
      ),
    ).toBeNull();
  });

  test("nothing to resolve before the queries land", () => {
    expect(includedMonthlyCreditsUsdFromPlans(undefined, undefined)).toBeNull();
  });
});

describe("utcMonthBefore", () => {
  test("steps back one calendar month", () => {
    expect(utcMonthBefore("2026-08-10T00:00:00Z")).toBe("2026-07-10");
  });

  test("clamps a day the shorter month cannot hold", () => {
    expect(utcMonthBefore("2026-03-31T00:00:00Z")).toBe("2026-02-28");
    expect(utcMonthBefore("2028-03-31T00:00:00Z")).toBe("2028-02-29");
  });

  test("crosses a year boundary", () => {
    expect(utcMonthBefore("2026-01-15T00:00:00Z")).toBe("2025-12-15");
  });

  test("returns null for an unparseable timestamp", () => {
    expect(utcMonthBefore("not a date")).toBeNull();
  });
});
