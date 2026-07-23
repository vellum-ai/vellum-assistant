/**
 * Tests for `useIsFreePlan`. The generated subscription retrieve query options
 * are `mock.module`-replaced so the hook reads a seeded fixture and its fetches
 * can be counted. The QueryClient uses `staleTime/gcTime: Infinity` +
 * `retry: false` so a seeded cache resolves synchronously and an unseeded query
 * stays unresolved (its `queryFn` is a hang) — modeling the loading state.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { SubscriptionResponse } from "@/generated/api/types.gen";

// Sentinel query key shared by the mocked options and the seeded cache.
const SUBSCRIPTION_KEY = ["subscription"];

// The fixture the mocked retrieve options resolve; each test seeds it.
let subscriptionFixture: SubscriptionResponse | null = null;
// Counts subscription fetches so the `enabled: false` gate can be asserted.
let subscriptionFetches = 0;
// When true, the query never resolves — models the first load still in flight.
let subscriptionHangs = false;
// Drives the mocked `useIsOrgReady`; the hook folds it into its `enabled` gate.
let orgReady = true;

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  organizationsBillingSubscriptionRetrieveOptions: () => ({
    queryKey: SUBSCRIPTION_KEY,
    queryFn: () => {
      subscriptionFetches += 1;
      return subscriptionHangs
        ? new Promise(() => {})
        : subscriptionFixture;
    },
  }),
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

const { useIsFreePlan } = await import("./use-is-free-plan");

function subscription(
  overrides: Partial<SubscriptionResponse> = {},
): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_end: "2026-07-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    selected_credit_tier: null,
    package: { key: "super", name: "Super", version: 1, customized: false },
    entitlements: { managed_email: false, phone_number: false },
    ...overrides,
  };
}

/**
 * Render the hook against a fresh QueryClient. When `seed` is set the
 * subscription cache is primed so the read resolves synchronously.
 */
function setup({
  seed,
  enabled = true,
}: {
  seed?: SubscriptionResponse;
  enabled?: boolean;
} = {}) {
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
    client.setQueryData(SUBSCRIPTION_KEY, seed);
  }
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  return renderHook(() => useIsFreePlan(enabled), { wrapper });
}

describe("useIsFreePlan", () => {
  beforeEach(() => {
    subscriptionFetches = 0;
    subscriptionHangs = false;
    subscriptionFixture = subscription();
    orgReady = true;
  });

  test("returns true for a base (free) plan", () => {
    const { result } = setup({ seed: subscription({ plan_id: "base" }) });
    expect(result.current).toBe(true);
  });

  test("returns false for a pro (paid) plan", () => {
    const { result } = setup({ seed: subscription({ plan_id: "pro" }) });
    expect(result.current).toBe(false);
  });

  test("returns undefined while the subscription is unresolved", () => {
    // No seeded data + a hanging fetch keeps the query pending.
    subscriptionHangs = true;
    const { result } = setup();
    expect(result.current).toBeUndefined();
  });

  test("does not fetch and returns undefined when disabled", () => {
    // Unseeded + disabled: the read must not fire and the value stays unknown.
    const { result } = setup({ enabled: false });
    expect(subscriptionFetches).toBe(0);
    expect(result.current).toBeUndefined();
  });

  test("does not fetch and returns undefined when the org is not ready", () => {
    // Even with `enabled` true, a not-ready org must keep the query from firing
    // — the request would omit `Vellum-Organization-Id` and be rejected.
    orgReady = false;
    const { result } = setup({ enabled: true });
    expect(subscriptionFetches).toBe(0);
    expect(result.current).toBeUndefined();
  });
});
