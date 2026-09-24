/**
 * Tests for `usePreferencesUsage`, and specifically for when it arms the BYOK
 * route classifier behind the extra-credits claim.
 *
 * The claim needs the subscription; the classifier's reads do not, so the two
 * run alongside each other and the first reading the hook produces already
 * carries the claim rather than a bar standing in for it. The contract these
 * tests hold is the arming one: armed off the summary for anyone whose grants
 * it can already see are spent, idle for everyone else.
 *
 * The subscription is driven from the SDK boundary the way the panel tests
 * drive it. The wallet status and the classifier are mocked: the real hooks
 * need the platform gate, the org store, and five daemon queries that these
 * tests do not stand up.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { ReactNode } from "react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { SubscriptionResponse } from "@/generated/api/types.gen";

let subscription: SubscriptionResponse | null = null;
/** Holds the subscription read open so the renders before it can be read. */
let holdSubscription = false;
/** Releases a held read, or null when none is waiting. */
let releaseSubscription: (() => void) | null = null;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingSubscriptionRetrieve: () => {
    const payload = { data: subscription, response: { ok: true } };
    if (!holdSubscription) {
      return Promise.resolve(payload);
    }
    return new Promise((resolve) => {
      releaseSubscription = () => resolve(payload);
    });
  },
}));

let billingEnabled = true;
let effectiveBalance: string | null = null;
let availableUsageBalance: string | null = null;
let totalUsageBalance: string | null = null;

mock.module("@/hooks/use-billing-balance-status", () => ({
  useBillingBalanceStatus: () => ({
    isExhausted: false,
    isLowBalance: false,
    dailyLimitReached: false,
    dailyLimitSnoozed: false,
    dailyLimit: null,
    dailySpend: null,
    freeTierDailyLimitEnforced: freeTierEnforced,
    freeTierDailyLimitReached: false,
    freeTierDailyLimitBlocked: false,
    freeTierDailyLimit: freeTierLimit,
    freeTierDailySpend: freeTierSpend,
    balance: effectiveBalance,
    availableUsageBalance,
    totalUsageBalance,
    enabled: billingEnabled,
    settled: true,
  }),
}));

/** The free-tier daily cap, where the platform is enforcing one. */
let freeTierEnforced = false;
let freeTierLimit: string | null = null;
let freeTierSpend: string | null = null;

/**
 * Every `candidate` the hook has asked the classifier with, in render order.
 * The arming contract is about when the reads start, which only this records:
 * a verdict read after the fact cannot say whether it was asked in time.
 */
let candidates: boolean[] = [];

/** Whether the classifier has been asked to run, and whether it has answered. */
let classifierArmed = false;
let classifierAnswered = false;

mock.module("@/hooks/use-byok-credit-banner-gate", () => ({
  useByokCreditRouteVerdict: (candidate: boolean) => {
    candidates.push(candidate);
    if (candidate && !classifierArmed) {
      classifierArmed = true;
      // The classifier reads five daemon queries, so its verdict lands a tick
      // after it is asked and never on the render that asks. A double that
      // answers instantly cannot tell arming early from arming late, which is
      // the whole of what these tests are about.
      setTimeout(() => {
        classifierAnswered = true;
      }, 0);
    }
    return {
      suppress: false,
      settled: !candidate || classifierAnswered,
      routeBurnsManaged: classifierAnswered,
    };
  },
}));

const { usePreferencesUsage } = await import("./use-preferences-usage");

function proSubscription(): SubscriptionResponse {
  return {
    plan_id: "pro",
    status: "active",
    renewal_date: null,
    current_period_start: "2026-07-10T00:00:00Z",
    current_period_end: "2026-08-10T00:00:00Z",
    cancel_at_period_end: false,
    cancel_at: null,
    package: { key: "mighty", name: "Mighty", version: 1, customized: false },
    entitlements: { managed_email: false, phone_number: false },
  };
}

function renderUsage() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  return renderHook(() => usePreferencesUsage({ conversationId: null }), {
    wrapper: ({ children }: { children: ReactNode }) => (
      <QueryClientProvider client={client}>{children}</QueryClientProvider>
    ),
  });
}

/** Lets the subscription read settle inside `act`, so nothing lands mid-assert. */
async function settle(): Promise<void> {
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

beforeEach(() => {
  subscription = proSubscription();
  holdSubscription = false;
  releaseSubscription = null;
  billingEnabled = true;
  // A wallet with credit behind fully spent grants: the state the panel
  // describes as running on extra usage credits.
  effectiveBalance = "12.00";
  totalUsageBalance = "5.00";
  availableUsageBalance = "0.00";
  candidates = [];
  classifierArmed = false;
  classifierAnswered = false;
  freeTierEnforced = false;
  freeTierLimit = null;
  freeTierSpend = null;
});

afterEach(() => {
  cleanup();
});

describe("usePreferencesUsage", () => {
  test("reads the free-tier day when it has the least left", async () => {
    // $3 left on the grant against $2 left today.
    availableUsageBalance = "3.00";
    freeTierEnforced = true;
    freeTierLimit = "5.00";
    freeTierSpend = "3.00";
    const { result } = renderUsage();

    await settle();
    expect(result.current.usage?.kind).toBe("daily");
    expect(result.current.usage?.ratio).toBeCloseTo(0.6);
    expect(result.current.usage?.spent).toBe(false);
  });

  test("reads the overall grant once it has less left than the day", async () => {
    // $1 left on the grant against $2 left today.
    availableUsageBalance = "1.00";
    freeTierEnforced = true;
    freeTierLimit = "5.00";
    freeTierSpend = "3.00";
    const { result } = renderUsage();

    await settle();
    expect(result.current.usage?.kind).toBe("overall");
    expect(result.current.usage?.ratio).toBeCloseTo(0.8);
  });

  test("a used-up day arms the classifier over the extra credit behind it", async () => {
    availableUsageBalance = "3.00";
    // $3 of frozen grant plus $9 bought on top.
    effectiveBalance = "12.00";
    freeTierEnforced = true;
    freeTierLimit = "5.00";
    freeTierSpend = "5.00";
    const { result } = renderUsage();

    await settle();
    expect(candidates).toContain(true);
    expect(result.current.usage?.kind).toBe("daily");
    expect(result.current.usage?.spent).toBe(true);
    expect(result.current.usage?.usingExtraCredits).toBe(true);
    expect(result.current.usage?.exhausted).toBe(false);
  });

  test("a used-up day backed only by frozen credit reads as exhausted", async () => {
    availableUsageBalance = "3.00";
    effectiveBalance = "3.00";
    freeTierEnforced = true;
    freeTierLimit = "5.00";
    freeTierSpend = "5.00";
    const { result } = renderUsage();

    await settle();
    expect(result.current.usage?.kind).toBe("daily");
    expect(result.current.usage?.exhausted).toBe(true);
    expect(result.current.usage?.usingExtraCredits).toBe(false);
  });

  test("arms the route classifier before the subscription answers", async () => {
    holdSubscription = true;
    const { result } = renderUsage();

    await settle();
    // Still no reading, because the plan has not landed. The classifier is
    // already running alongside that request.
    expect(result.current.usage).toBeNull();
    expect(candidates).toContain(true);
  });

  test("the first reading it produces is already the settled one", async () => {
    holdSubscription = true;
    const { result } = renderUsage();
    await settle();

    await act(async () => {
      releaseSubscription?.();
      await new Promise((resolve) => setTimeout(resolve, 0));
    });

    // The render that first carries a reading carries the claim with it, so
    // the panel never paints the bar on its way to the amber line.
    expect(result.current.settled).toBe(true);
    expect(result.current.usage?.usingExtraCredits).toBe(true);
  });

  test("stays idle while the grants still have room", async () => {
    availableUsageBalance = "3.00";
    renderUsage();

    await settle();
    expect(candidates).not.toContain(true);
  });

  test("stays idle with nothing in the wallet to spend", async () => {
    effectiveBalance = "0.00";
    renderUsage();

    await settle();
    expect(candidates).not.toContain(true);
  });

  test("stays idle without managed billing to read", async () => {
    billingEnabled = false;
    renderUsage();

    await settle();
    expect(candidates).not.toContain(true);
  });

  test("arms on the plan's fallback for a Pro sub with no live grants", async () => {
    // Every grant expired, so the summary alone has no ratio to read and the
    // full bar comes from the plan. That reading still arms the classifier,
    // just at the subscription rather than ahead of it.
    totalUsageBalance = "0.00";
    availableUsageBalance = "0.00";
    const { result } = renderUsage();

    await settle();
    expect(result.current.usage?.spent).toBe(true);
    expect(candidates.at(-1)).toBe(true);
  });

  test("a free plan that was never granted credit arms nothing", async () => {
    subscription = { ...proSubscription(), plan_id: "base", package: null };
    totalUsageBalance = null;
    availableUsageBalance = null;
    const { result } = renderUsage();

    await settle();
    expect(result.current.usage).toBeNull();
    expect(candidates).not.toContain(true);
  });
});
