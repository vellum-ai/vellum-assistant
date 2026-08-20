/**
 * Tests for usePlanUsageBalance: the Plan section's usage-balance reading.
 *
 * The hook only speaks when every input is trustworthy: the `obscure-credits`
 * flag on, a Pro sub, a package with a positive credit bundle, and a settled
 * totals read. Most of these assert the null cases that keep a wrong number
 * off the card. The usage endpoint is driven from the SDK boundary, mirroring
 * the other billing hook tests.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import type { ReactNode } from "react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { ProPackage } from "@/domains/settings/billing/package-types";
import type { SubscriptionResponse } from "@/generated/api/types.gen";

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
const { usePlanUsageBalance, utcMonthBefore } = await import(
  "./use-plan-usage-balance"
);

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
  currentPackage: ProPackage | null;
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
  test("reports spend against the package's included credits", async () => {
    const { result } = renderBalance({
      subscription: proSubscription(),
      currentPackage: mightyPackage(25),
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
      currentPackage: mightyPackage(25),
    });

    await waitFor(() => {
      expect(result.current).not.toBeNull();
    });
    expect(result.current?.ratio).toBe(1);
  });

  test("derives the cycle start by subtracting a month from the end", async () => {
    const { result } = renderBalance({
      subscription: proSubscription(),
      currentPackage: mightyPackage(25),
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
      currentPackage: mightyPackage(25),
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
      currentPackage: mightyPackage(25),
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
      currentPackage: null,
    });

    await act(async () => {
      await Promise.resolve();
    });
    expect(result.current).toBeNull();
    expect(totalsCalls).toBe(0);
  });

  test("stays silent when the package carries no credit bundle", async () => {
    const { result } = renderBalance({
      subscription: proSubscription(),
      currentPackage: mightyPackage(null),
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
      currentPackage: mightyPackage(25),
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
