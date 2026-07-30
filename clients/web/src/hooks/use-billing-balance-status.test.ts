/**
 * Tests for `useBillingBalanceStatus`. The generated billing-summary query
 * options are `mock.module`-replaced so the hook reads a seeded fixture and
 * its fetches can be counted; the platform-gate and org-ready hooks are
 * mocked so each gating leg can be flipped independently. The QueryClient
 * uses `staleTime/gcTime: Infinity` + `retry: false` so a seeded cache
 * resolves synchronously and an unseeded query stays unresolved (its
 * `queryFn` hangs), modeling the loading state.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { BillingSummaryResponse } from "@/generated/api/types.gen";
import type { PlatformGateState } from "@/hooks/use-platform-gate";

// Sentinel query key shared by the mocked options and the seeded cache.
const BILLING_SUMMARY_KEY = ["billing-summary"];

// The fixture the mocked retrieve options resolve; each test seeds it.
let summaryFixture: BillingSummaryResponse | null = null;
// Counts summary fetches so the `enabled: false` gate can be asserted.
let summaryFetches = 0;
// When true, the query never resolves, modeling the first load still in flight.
let summaryHangs = false;
// Drive the mocked gating hooks; the hook folds all three into `enabled`.
let platformGate: PlatformGateState = "full";
let isPlatformHosted = true;
let orgReady = true;

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  organizationsBillingSummaryRetrieveOptions: () => ({
    queryKey: BILLING_SUMMARY_KEY,
    queryFn: () => {
      summaryFetches += 1;
      return summaryHangs ? new Promise(() => {}) : summaryFixture;
    },
  }),
  // Not read by the hook, but `mock.module` is process-wide in bun: other
  // suites sharing the process import this export from the same module.
  organizationsBillingSummaryRetrieveQueryKey: () => BILLING_SUMMARY_KEY,
}));

mock.module("@/hooks/use-platform-gate", () => ({
  usePlatformGate: () => platformGate,
  useActiveAssistantIsPlatformHosted: () => isPlatformHosted,
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

const { useBillingBalanceStatus } = await import(
  "./use-billing-balance-status"
);

function summary(
  overrides: Partial<BillingSummaryResponse> = {},
): BillingSummaryResponse {
  return {
    settled_balance: "20.00",
    minimum_top_up: "5.00",
    maximum_top_up: "100.00",
    maximum_balance: "500.00",
    allowed_top_up_amounts: ["5.00", "10.00", "25.00"],
    settled_balance_usd: "20.00",
    minimum_top_up_usd: "5.00",
    maximum_top_up_usd: "100.00",
    maximum_balance_usd: "500.00",
    pending_compute: "0.00",
    pending_compute_usd: "0.00",
    effective_balance: "20.00",
    effective_balance_usd: "20.00",
    is_degraded: false,
    daily_credit_limit_usd: null,
    daily_spend_usd: "0.00",
    daily_limit_reached: false,
    low_balance_threshold_usd: "5.00",
    low_balance_warning: false,
    ...overrides,
  };
}

/**
 * Render the hook against a fresh QueryClient. When `seed` is set the
 * billing-summary cache is primed so the read resolves synchronously.
 */
function setup({ seed }: { seed?: BillingSummaryResponse } = {}) {
  const client = new QueryClient({
    defaultOptions: {
      queries: {
        retry: false,
        staleTime: Infinity,
        refetchOnMount: false,
        refetchOnWindowFocus: false,
        gcTime: Infinity,
      },
    },
  });
  if (seed) {
    client.setQueryData(BILLING_SUMMARY_KEY, seed);
  }
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useBillingBalanceStatus(), { wrapper });
}

describe("useBillingBalanceStatus", () => {
  beforeEach(() => {
    summaryFetches = 0;
    summaryHangs = false;
    summaryFixture = summary();
    platformGate = "full";
    isPlatformHosted = true;
    orgReady = true;
  });

  test("normal balance: both flags false, balance exposed", () => {
    const { result } = setup({
      seed: summary({ effective_balance: "20.00", low_balance_warning: false }),
    });
    expect(result.current).toEqual({
      isExhausted: false,
      isLowBalance: false,
      balance: "20.00",
      enabled: true,
    });
  });

  test("low balance: reflects the server-computed warning flag", () => {
    const { result } = setup({
      seed: summary({ effective_balance: "3.00", low_balance_warning: true }),
    });
    expect(result.current).toEqual({
      isExhausted: false,
      isLowBalance: true,
      balance: "3.00",
      enabled: true,
    });
  });

  test("exhausted: zero effective balance", () => {
    const { result } = setup({
      seed: summary({ effective_balance: "0.00", low_balance_warning: false }),
    });
    expect(result.current.isExhausted).toBe(true);
    expect(result.current.isLowBalance).toBe(false);
    expect(result.current.balance).toBe("0.00");
  });

  test("exhausted: negative effective balance", () => {
    const { result } = setup({ seed: summary({ effective_balance: "-1.37" }) });
    expect(result.current.isExhausted).toBe(true);
  });

  test("all-false while the summary is unresolved", () => {
    // No seeded data + a hanging fetch keeps the query pending.
    summaryHangs = true;
    const { result } = setup();
    expect(result.current).toEqual({
      isExhausted: false,
      isLowBalance: false,
      balance: null,
      enabled: true,
    });
  });

  test.each([
    ["the platform gate is not full", () => (platformGate = "gated")],
    ["the platform gate is disabled", () => (platformGate = "disabled")],
    ["the assistant is not platform-hosted", () => (isPlatformHosted = false)],
    ["the org is not ready", () => (orgReady = false)],
  ] as const)("inert and does not fetch when %s", (_label, gateOff) => {
    gateOff();
    const { result } = setup();
    expect(summaryFetches).toBe(0);
    expect(result.current).toEqual({
      isExhausted: false,
      isLowBalance: false,
      balance: null,
      enabled: false,
    });
  });

  test("stays inert on cached data when gated off", () => {
    // Even with a seeded (stale) summary in the cache, a gated-off hook must
    // not surface it: unknown/ineligible state never flashes a billing card.
    isPlatformHosted = false;
    const { result } = setup({
      seed: summary({ effective_balance: "0.00", low_balance_warning: true }),
    });
    expect(result.current).toEqual({
      isExhausted: false,
      isLowBalance: false,
      balance: null,
      enabled: false,
    });
  });
});
