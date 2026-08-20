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
import { act, renderHook } from "@testing-library/react";
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

// Verdict of the BYOK gate; the real hook (own queries, own suite) is
// replaced so each side of the suppression can be driven directly. The
// candidate flags are recorded so the lazy-gating contract (the gate only
// engages when a balance banner would actually show) can be asserted.
let byokSuppression = false;
let byokGateCandidates: boolean[] = [];

mock.module("@/hooks/use-byok-credit-banner-gate", () => ({
  useSuppressCreditBannersForByok: (candidate: boolean) => {
    byokGateCandidates.push(candidate);
    return candidate && byokSuppression;
  },
}));

const { useBillingBalanceStatus } =
  await import("./use-billing-balance-status");
const { resolveComposerBillingBanner } =
  await import("@/domains/chat/utils/error-classification");

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
    daily_limit_snoozed: false,
    low_balance_threshold_usd: "5.00",
    low_balance_warning: false,
    credits_expiring_soon_usd: "0.00",
    next_credit_expiry_at: null,
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
  return {
    ...renderHook(() => useBillingBalanceStatus(), { wrapper }),
    // Exposed so a test can stand in for a summary invalidation refetch by
    // writing the refreshed response into the same cache entry.
    client,
  };
}

describe("useBillingBalanceStatus", () => {
  beforeEach(() => {
    summaryFetches = 0;
    summaryHangs = false;
    summaryFixture = summary();
    platformGate = "full";
    isPlatformHosted = true;
    orgReady = true;
    byokSuppression = false;
    byokGateCandidates = [];
  });

  test("normal balance: both flags false, balance exposed", () => {
    const { result } = setup({
      seed: summary({ effective_balance: "20.00", low_balance_warning: false }),
    });
    expect(result.current).toEqual({
      isExhausted: false,
      isLowBalance: false,
      dailyLimitReached: false,
      dailyLimitSnoozed: false,
      dailyLimit: null,
      dailySpend: "0.00",
      balance: "20.00",
      availableUsageBalance: null,
      totalUsageBalance: null,
      enabled: true,
    });
  });

  test("usage grants: passed through as the summary reports them", () => {
    const { result } = setup({
      seed: summary({
        available_usage_balance: "1.60",
        total_usage_balance: "5.00",
      }),
    });
    expect(result.current.availableUsageBalance).toBe("1.60");
    expect(result.current.totalUsageBalance).toBe("5.00");
  });

  test("usage grants: a platform reporting neither reads as unknown", () => {
    // An older self-hosted platform omits both fields, which has to read as
    // "no grant information" rather than a zeroed one.
    const { result } = setup({ seed: summary() });
    expect(result.current.availableUsageBalance).toBeNull();
    expect(result.current.totalUsageBalance).toBeNull();
  });

  test("low balance: reflects the server-computed warning flag", () => {
    const { result } = setup({
      seed: summary({ effective_balance: "3.00", low_balance_warning: true }),
    });
    expect(result.current).toEqual({
      isExhausted: false,
      isLowBalance: true,
      dailyLimitReached: false,
      dailyLimitSnoozed: false,
      dailyLimit: null,
      dailySpend: "0.00",
      balance: "3.00",
      availableUsageBalance: null,
      totalUsageBalance: null,
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

  test("exhausted status never co-shows with the low-balance banner", () => {
    // Server contract: `low_balance_warning` is kept false while the balance
    // is exhausted, so an exhausted status (which drives the proactive upsell
    // card) always fails the low-balance leg of the composer banner decision.
    // The exclusivity lives server-side; this pins the client wiring to it.
    const { result } = setup({
      seed: summary({ effective_balance: "0.00", low_balance_warning: false }),
    });
    expect(result.current.isExhausted).toBe(true);
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        isLowBalance: result.current.isLowBalance,
        dismissed: false,
      }),
    ).toBeNull();
  });

  test("daily limit: reflects the server-computed daily_limit_reached flag", () => {
    // Orthogonal to the balance: the cap can be hit with credits to spare.
    const { result } = setup({
      seed: summary({ effective_balance: "20.00", daily_limit_reached: true }),
    });
    expect(result.current).toEqual({
      isExhausted: false,
      isLowBalance: false,
      dailyLimitReached: true,
      dailyLimitSnoozed: false,
      dailyLimit: null,
      dailySpend: "0.00",
      balance: "20.00",
      availableUsageBalance: null,
      totalUsageBalance: null,
      enabled: true,
    });
  });

  test("daily limit drives the composer banner with no chat error present", () => {
    // The proactive path: background turns reached the cap while the user was
    // away, so the banner must be up before any send fails.
    const { result } = setup({
      seed: summary({ daily_limit_reached: true }),
    });
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        isLowBalance: result.current.isLowBalance,
        dismissed: false,
        dailyLimitReached: result.current.dailyLimitReached,
      }),
    ).toBe("daily_limit");
  });

  test("daily limit outranks a co-reported low-balance warning", () => {
    const { result } = setup({
      seed: summary({
        effective_balance: "3.00",
        low_balance_warning: true,
        daily_limit_reached: true,
      }),
    });
    expect(result.current.isLowBalance).toBe(true);
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        isLowBalance: result.current.isLowBalance,
        dismissed: false,
        dailyLimitReached: result.current.dailyLimitReached,
      }),
    ).toBe("daily_limit");
  });

  test("a gated-off hook never raises the daily-limit banner", () => {
    // Cached summary, gated-off query: the inert status keeps the banner down
    // for self-hosted and org-not-ready contexts.
    isPlatformHosted = false;
    const { result } = setup({ seed: summary({ daily_limit_reached: true }) });
    expect(result.current.dailyLimitReached).toBe(false);
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        isLowBalance: result.current.isLowBalance,
        dismissed: false,
        dailyLimitReached: result.current.dailyLimitReached,
      }),
    ).toBeNull();
  });

  test("raising the limit clears the banner once the summary refetches", () => {
    // The settings card invalidates the summary on save; the refreshed
    // response flips the flag and the banner drops on the next read.
    const { result, rerender, client } = setup({
      seed: summary({ daily_limit_reached: true }),
    });
    expect(result.current.dailyLimitReached).toBe(true);
    act(() => {
      client.setQueryData(
        BILLING_SUMMARY_KEY,
        summary({ daily_limit_reached: false }),
      );
    });
    // Bun's preload does not set `IS_REACT_ACT_ENVIRONMENT`, so the query
    // notification does not flush on its own here; the explicit rerender
    // reads the hook against the refreshed cache entry.
    rerender();
    expect(result.current.dailyLimitReached).toBe(false);
    expect(
      resolveComposerBillingBanner({
        billingBannerDecision: null,
        isLowBalance: result.current.isLowBalance,
        dismissed: false,
        dailyLimitReached: result.current.dailyLimitReached,
      }),
    ).toBeNull();
  });

  test("all-false while the summary is unresolved", () => {
    // No seeded data + a hanging fetch keeps the query pending.
    summaryHangs = true;
    const { result } = setup();
    expect(result.current).toEqual({
      isExhausted: false,
      isLowBalance: false,
      dailyLimitReached: false,
      dailyLimitSnoozed: false,
      dailyLimit: null,
      dailySpend: null,
      balance: null,
      availableUsageBalance: null,
      totalUsageBalance: null,
      enabled: true,
    });
  });

  test.each([
    [
      "the platform gate is not full",
      () => {
        platformGate = "gated";
      },
    ],
    [
      "the platform gate is disabled",
      () => {
        platformGate = "disabled";
      },
    ],
    [
      "the assistant is not platform-hosted",
      () => {
        isPlatformHosted = false;
      },
    ],
    [
      "the org is not ready",
      () => {
        orgReady = false;
      },
    ],
  ] as const)("inert and does not fetch when %s", (_label, gateOff) => {
    gateOff();
    const { result } = setup();
    expect(summaryFetches).toBe(0);
    expect(result.current).toEqual({
      isExhausted: false,
      isLowBalance: false,
      dailyLimitReached: false,
      dailyLimitSnoozed: false,
      dailyLimit: null,
      dailySpend: null,
      balance: null,
      availableUsageBalance: null,
      totalUsageBalance: null,
      enabled: false,
    });
  });

  test("BYOK suppression clears the balance flags but not the daily limit", () => {
    byokSuppression = true;
    const { result } = setup({
      seed: summary({
        effective_balance: "0.00",
        daily_limit_reached: true,
      }),
    });
    expect(result.current).toEqual({
      isExhausted: false,
      isLowBalance: false,
      dailyLimitReached: true,
      dailyLimitSnoozed: false,
      dailyLimit: null,
      dailySpend: "0.00",
      balance: "0.00",
      availableUsageBalance: null,
      totalUsageBalance: null,
      enabled: true,
    });
  });

  test("BYOK suppression clears the low-balance warning", () => {
    byokSuppression = true;
    const { result } = setup({
      seed: summary({ effective_balance: "3.00", low_balance_warning: true }),
    });
    expect(result.current.isLowBalance).toBe(false);
    expect(result.current.balance).toBe("3.00");
  });

  test("the BYOK gate only engages when a balance banner would show", () => {
    setup({
      seed: summary({ effective_balance: "20.00", low_balance_warning: false }),
    });
    expect(byokGateCandidates).not.toContain(true);

    byokGateCandidates = [];
    setup({ seed: summary({ effective_balance: "0.00" }) });
    expect(byokGateCandidates).toContain(true);
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
      dailyLimitReached: false,
      dailyLimitSnoozed: false,
      dailyLimit: null,
      dailySpend: null,
      balance: null,
      availableUsageBalance: null,
      totalUsageBalance: null,
      enabled: false,
    });
  });
});
