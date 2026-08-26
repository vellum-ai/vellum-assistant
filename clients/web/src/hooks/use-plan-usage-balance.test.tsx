/**
 * Tests for the Plan section's usage-balance reading.
 *
 * The hook reads entirely off the billing summary's usage-grant figures, so
 * there is no endpoint to drive: every case seeds the two figures and the
 * subscription directly. The hook only speaks when the `obscure-credits` flag
 * is on and the figures support an honest reading, with one deliberate
 * exception: a Pro sub whose unexpired grants total nothing reads as a fully
 * spent bar rather than no bar at all. `usageGrantRatio` is the pure half
 * that resolves the ratio.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { act, renderHook } from "@testing-library/react";

import type { SubscriptionResponse } from "@/generated/api/types.gen";

const { useClientFeatureFlagStore } =
  await import("@/stores/client-feature-flag-store");
const { usePlanUsageBalance, usageGrantRatio } =
  await import("./use-plan-usage-balance");

function setObscureCredits(value: boolean): void {
  act(() => {
    useClientFeatureFlagStore
      .getState()
      .setFlags({ obscureCredits: value }, null);
  });
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

/** A free (base) sub: no package and no cycle its grants renew on. */
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

function renderBalance(args: {
  subscription: SubscriptionResponse | undefined;
  availableUsageBalance?: string | null;
  totalUsageBalance?: string | null;
}) {
  return renderHook(() => usePlanUsageBalance(args));
}

beforeEach(() => {
  setObscureCredits(true);
});

afterEach(() => {
  setObscureCredits(false);
});

describe("usePlanUsageBalance on a Pro sub", () => {
  test("reads the used share of the grants", () => {
    // $10 of the $25 the cycle granted is gone.
    const { result } = renderBalance({
      subscription: proSubscription(),
      totalUsageBalance: "25.00",
      availableUsageBalance: "15.00",
    });

    expect(result.current?.ratio).toBeCloseTo(0.4, 6);
  });

  test("grants used to nothing read as a full bar", () => {
    const { result } = renderBalance({
      subscription: proSubscription(),
      totalUsageBalance: "25.00",
      availableUsageBalance: "0.00",
    });

    expect(result.current?.ratio).toBe(1);
  });

  test("more unused than granted clamps rather than going negative", () => {
    const { result } = renderBalance({
      subscription: proSubscription(),
      totalUsageBalance: "25.00",
      availableUsageBalance: "26.00",
    });

    expect(result.current?.ratio).toBe(0);
  });

  test("a zero grant total is a fully spent bar", () => {
    // Every grant expired or used up: the plan has nothing left to give, so
    // the bar reads full rather than disappearing.
    const { result } = renderBalance({
      subscription: proSubscription(),
      totalUsageBalance: "0.00",
      availableUsageBalance: "0.00",
    });

    expect(result.current?.ratio).toBe(1);
  });

  test("a zero total needs no available figure to read as spent", () => {
    // The denominator alone decides this state.
    const { result } = renderBalance({
      subscription: proSubscription(),
      totalUsageBalance: "0.00",
      availableUsageBalance: null,
    });

    expect(result.current?.ratio).toBe(1);
  });

  test("stays silent while the flag is off", () => {
    setObscureCredits(false);
    const { result } = renderBalance({
      subscription: proSubscription(),
      totalUsageBalance: "25.00",
      availableUsageBalance: "15.00",
    });

    expect(result.current).toBeNull();
  });

  test("stays silent when the platform reports no grant figures", () => {
    // An older platform omits both; there is no honest reading, full or
    // otherwise.
    const { result } = renderBalance({
      subscription: proSubscription(),
    });

    expect(result.current).toBeNull();
  });

  test("stays silent on a positive total missing its available figure", () => {
    const { result } = renderBalance({
      subscription: proSubscription(),
      totalUsageBalance: "25.00",
      availableUsageBalance: null,
    });

    expect(result.current).toBeNull();
  });

  test("stays silent before the subscription lands", () => {
    const { result } = renderBalance({
      subscription: undefined,
      totalUsageBalance: "25.00",
      availableUsageBalance: "15.00",
    });

    expect(result.current).toBeNull();
  });
});

describe("usePlanUsageBalance on a free plan", () => {
  test("measures the used share of the usage grants", () => {
    const { result } = renderBalance({
      subscription: freeSubscription(),
      totalUsageBalance: "5.00",
      availableUsageBalance: "1.60",
    });

    expect(result.current?.ratio).toBeCloseTo(0.68, 6);
  });

  test("a further grant lowers the reading", () => {
    const { result } = renderBalance({
      subscription: freeSubscription(),
      totalUsageBalance: "10.00",
      availableUsageBalance: "6.60",
    });

    expect(result.current?.ratio).toBeCloseTo(0.34, 6);
  });

  test("a fully used grant reads as a full bar", () => {
    const { result } = renderBalance({
      subscription: freeSubscription(),
      totalUsageBalance: "5.00",
      availableUsageBalance: "0.00",
    });

    expect(result.current?.ratio).toBe(1);
  });

  test("an account that was never granted credit has no bar", () => {
    // Unlike a Pro sub, a free plan with a zero total was simply never
    // granted anything: no reading, and the tile keeps its price row.
    const { result } = renderBalance({
      subscription: freeSubscription(),
      totalUsageBalance: "0.00",
      availableUsageBalance: "0.00",
    });

    expect(result.current).toBeNull();
  });

  test("stays silent while the flag is off", () => {
    setObscureCredits(false);
    const { result } = renderBalance({
      subscription: freeSubscription(),
      totalUsageBalance: "5.00",
      availableUsageBalance: "1.60",
    });

    expect(result.current).toBeNull();
  });

  test("stays silent before the summary lands", () => {
    const { result } = renderBalance({
      subscription: freeSubscription(),
    });

    expect(result.current).toBeNull();
  });

  test("stays silent when the platform reports only one figure", () => {
    // An older self-hosted platform omits both; a partial read is no more
    // usable than none.
    const { result } = renderBalance({
      subscription: freeSubscription(),
      totalUsageBalance: "5.00",
      availableUsageBalance: null,
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
