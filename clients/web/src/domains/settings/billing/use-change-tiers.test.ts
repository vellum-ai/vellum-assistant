/**
 * Tests for `useChangeTiers`. The three generated change-tier mutations, the
 * subscription/onboarding retrieve query options, and the billing query-key
 * factories are `mock.module`-replaced so the hook reads seeded fixtures and
 * dispatches against controllable `mutationFn`s. `extractMutationError` (real)
 * turns a `{ detail }` reject into the toasted message. The seeded QueryClient
 * uses `staleTime/gcTime: Infinity` + `retry: false` so the queries resolve
 * synchronously from the cache and never hit the network.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type {
  OnboardingStateResponse,
  PlanListResponse,
  SubscriptionResponse,
} from "@/generated/api/types.gen";

import type { ChangeTiersResult } from "./use-change-tiers";

// Sentinel query keys let the invalidation assertions match on identity.
const SUBSCRIPTION_KEY = ["subscription"];
const ONBOARDING_KEY = ["onboarding"];
const PLANS_KEY = ["plans"];

// The fixtures the mocked retrieve options resolve; each test seeds them.
let subscriptionFixture: SubscriptionResponse | null = null;
let onboardingFixture: OnboardingStateResponse | null = null;
let plansFixture: PlanListResponse | null = null;
// When true, the onboarding query stays pending (its first load never lands).
let onboardingHangs = false;

/** Pro catalog whose machine tiers carry the prices used to rank up/downgrades. */
function proPlans(): PlanListResponse {
  return {
    plans: [
      {
        id: "pro",
        name: "Pro",
        base_lookup_key: "pro_base",
        base_price_cents: 2000,
        billing_interval: "month",
        included_features: [],
        machine_tiers: [
          {
            tier: "medium",
            label: "medium",
            price_cents: 3500,
            lookup_key: "machine_m",
            cpu_limit: "2.5",
            memory_gib: 5,
            description: "Medium",
          },
          {
            tier: "large",
            label: "large",
            price_cents: 6000,
            lookup_key: "machine_l",
            cpu_limit: "4",
            memory_gib: 8,
            description: "Large",
          },
        ],
        storage_tiers: [],
        credit_tiers: [],
        packages: [],
      },
    ],
  };
}

// Per-dimension captured bodies + resolution controls.
type Body = { body: Record<string, unknown> };
const machineCalls: Body[] = [];
const storageCalls: Body[] = [];
const creditCalls: Body[] = [];
let machineImpl: (opts: Body) => Promise<unknown>;
let storageImpl: (opts: Body) => Promise<unknown>;
let creditImpl: (opts: Body) => Promise<unknown>;
// Counts subscription fetches so the readiness gate can be asserted.
let subscriptionFetches = 0;

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  organizationsBillingSubscriptionRetrieveOptions: () => ({
    queryKey: SUBSCRIPTION_KEY,
    queryFn: () => {
      subscriptionFetches += 1;
      return subscriptionFixture;
    },
  }),
  organizationsBillingSubscriptionRetrieveQueryKey: () => SUBSCRIPTION_KEY,
  organizationsBillingSubscriptionOnboardingRetrieveOptions: () => ({
    queryKey: ONBOARDING_KEY,
    // When `onboardingHangs`, never resolves — models the first onboarding load
    // still in flight so `currentReady` can be exercised.
    queryFn: () =>
      onboardingHangs ? new Promise(() => {}) : onboardingFixture,
  }),
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey: () =>
    ONBOARDING_KEY,
  organizationsBillingPlansRetrieveOptions: () => ({
    queryKey: PLANS_KEY,
    queryFn: () => plansFixture,
  }),
  organizationsBillingPlansRetrieveQueryKey: () => PLANS_KEY,
  organizationsBillingSubscriptionChangeMachineTierCreateMutation: () => ({
    mutationFn: (opts: Body) => {
      machineCalls.push(opts);
      return machineImpl(opts);
    },
  }),
  organizationsBillingSubscriptionChangeStorageTierCreateMutation: () => ({
    mutationFn: (opts: Body) => {
      storageCalls.push(opts);
      return storageImpl(opts);
    },
  }),
  organizationsBillingSubscriptionChangeCreditTierCreateMutation: () => ({
    mutationFn: (opts: Body) => {
      creditCalls.push(opts);
      return creditImpl(opts);
    },
  }),
}));

const toastErrorCalls: string[] = [];
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    error: (message: string) => {
      toastErrorCalls.push(message);
    },
  },
}));

const { useChangeTiers } = await import("./use-change-tiers");

function proSubscription(
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

function onboarding(
  overrides: Partial<OnboardingStateResponse> = {},
): OnboardingStateResponse {
  return {
    max_machine_tier: "medium",
    selected_storage_tier: "xs",
    selected_storage_gib: 10,
    pvc_ready: true,
    domain_setup_available: false,
    primary_assistant_id: null,
    ...overrides,
  };
}

/**
 * Render the hook against a fresh QueryClient seeded with the current fixtures,
 * recording every key passed to `invalidateQueries`.
 */
function setup({
  seedOnboarding = true,
  seedSubscription = true,
  enabled = true,
}: {
  seedOnboarding?: boolean;
  seedSubscription?: boolean;
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
  if (seedSubscription) {
    client.setQueryData(SUBSCRIPTION_KEY, subscriptionFixture);
  }
  client.setQueryData(PLANS_KEY, plansFixture);
  if (seedOnboarding) {
    client.setQueryData(ONBOARDING_KEY, onboardingFixture);
  }
  const invalidatedKeys: unknown[] = [];
  // Ordered log of when each invalidation settled, so a test can prove
  // `changeTiers` resolves only after they have.
  const events: string[] = [];
  type InvalidateFn = QueryClient["invalidateQueries"];
  const originalInvalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((...args: Parameters<InvalidateFn>) => {
    invalidatedKeys.push(args[0]?.queryKey);
    return originalInvalidate(...args).then(() => {
      events.push("invalidated");
    });
  }) as InvalidateFn;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const { result } = renderHook(() => useChangeTiers({ enabled }), { wrapper });
  return { result, invalidatedKeys, events };
}

describe("useChangeTiers", () => {
  beforeEach(() => {
    machineCalls.length = 0;
    storageCalls.length = 0;
    creditCalls.length = 0;
    toastErrorCalls.length = 0;
    machineImpl = async () => ({});
    storageImpl = async () => ({});
    creditImpl = async () => ({});
    onboardingHangs = false;
    subscriptionFetches = 0;
    subscriptionFixture = proSubscription();
    onboardingFixture = onboarding();
    plansFixture = proPlans();
  });

  test("holds the org-scoped subscription read until enabled", async () => {
    // Disabled (the caller's platform gate is not open yet) and unseeded, so
    // the org-scoped read must not fire without the org header.
    const { result } = setup({ enabled: false, seedSubscription: false });
    await act(async () => {
      await Promise.resolve();
    });
    expect(subscriptionFetches).toBe(0);
    expect(result.current.eligible).toBe(false);
  });

  test("derives current tiers and eligibility for an active Pro sub", () => {
    const { result } = setup();
    expect(result.current.current).toEqual({
      machineTier: "medium",
      storageTier: "xs",
      storageGib: 10,
      creditTier: null,
    });
    expect(result.current.eligible).toBe(true);
  });

  test("is ineligible when the sub is cancelling", () => {
    subscriptionFixture = proSubscription({ cancel_at_period_end: true });
    const { result } = setup();
    expect(result.current.eligible).toBe(false);
  });

  test("is ineligible in a non-entitlement status", () => {
    subscriptionFixture = proSubscription({ status: "unpaid" });
    const { result } = setup();
    expect(result.current.eligible).toBe(false);
  });

  test("is ineligible for a base sub", () => {
    subscriptionFixture = proSubscription({ plan_id: "base" });
    const { result } = setup();
    expect(result.current.eligible).toBe(false);
  });

  test("currentReady is false while the onboarding query is still loading", () => {
    // No seeded onboarding data + a hanging fetch keeps the query pending.
    onboardingHangs = true;
    const { result } = setup({ seedOnboarding: false });
    expect(result.current.currentReady).toBe(false);
    // The current tiers aren't known yet, so they read as null.
    expect(result.current.current.machineTier).toBeNull();
    expect(result.current.current.storageTier).toBeNull();
  });

  test("currentReady is true once the onboarding data is present", () => {
    const { result } = setup();
    expect(result.current.currentReady).toBe(true);
  });

  test("currentReady is true for a base sub (no onboarding to await)", () => {
    subscriptionFixture = proSubscription({ plan_id: "base" });
    onboardingHangs = true;
    const { result } = setup({ seedOnboarding: false });
    expect(result.current.currentReady).toBe(true);
  });

  test("fires only the changed dimensions and invalidates on success", async () => {
    // Current is medium/xs/null; change machine + credit, keep storage.
    const { result, invalidatedKeys } = setup();

    const captured: { value: ChangeTiersResult | null } = { value: null };
    await act(async () => {
      captured.value = await result.current.changeTiers({
        machineTier: "large",
        storageTier: "xs",
        creditTier: "credits_50",
      });
    });

    expect(machineCalls).toEqual([{ body: { machine_tier: "large" } }]);
    expect(creditCalls).toEqual([{ body: { credit_tier: "credits_50" } }]);
    // Storage is unchanged, so no storage-tier call fires.
    expect(storageCalls).toEqual([]);
    expect(invalidatedKeys).toEqual([
      SUBSCRIPTION_KEY,
      ONBOARDING_KEY,
      PLANS_KEY,
    ]);
    expect(toastErrorCalls).toEqual([]);
    // A machine change resizes the assistant; the credit change persisted too.
    expect(captured.value).toEqual({ needsResize: true, creditChanged: true });
  });

  test("a storage upgrade needs a resize", async () => {
    const { result } = setup();

    const captured: { value: ChangeTiersResult | null } = { value: null };
    await act(async () => {
      captured.value = await result.current.changeTiers({
        machineTier: "medium",
        storageTier: "s",
        creditTier: null,
      });
    });

    expect(storageCalls).toEqual([{ body: { storage_tier: "s" } }]);
    expect(machineCalls).toEqual([]);
    expect(captured.value).toEqual({ needsResize: true, creditChanged: false });
  });

  test("billing refetches are awaited before the result resolves", async () => {
    // The resize takeover reads the onboarding query and treats cached data as
    // loaded, so every invalidation must settle before the caller opens it —
    // otherwise a machine upgrade applies against the pre-change ceiling.
    const { result, events } = setup();

    await act(async () => {
      await result.current.changeTiers({
        machineTier: "large",
        storageTier: "xs",
        creditTier: null,
      });
      events.push("resolved");
    });

    expect(events).toEqual([
      "invalidated",
      "invalidated",
      "invalidated",
      "resolved",
    ]);
  });

  test("a machine downgrade does not need a resize", async () => {
    // Current machine is large; lowering to medium is a downgrade (cheaper),
    // which is capped server-side and must not open the resize takeover.
    onboardingFixture = onboarding({ max_machine_tier: "large" });
    const { result } = setup();

    const captured: { value: ChangeTiersResult | null } = { value: null };
    await act(async () => {
      captured.value = await result.current.changeTiers({
        machineTier: "medium",
        storageTier: "xs",
        creditTier: null,
      });
    });

    expect(machineCalls).toEqual([{ body: { machine_tier: "medium" } }]);
    expect(captured.value).toEqual({
      needsResize: false,
      creditChanged: false,
    });
  });

  test("a credit-only change surfaces the takeover without a resize", async () => {
    const { result } = setup();

    const captured: { value: ChangeTiersResult | null } = { value: null };
    await act(async () => {
      captured.value = await result.current.changeTiers({
        machineTier: "medium",
        storageTier: "xs",
        creditTier: "credits_50",
      });
    });

    expect(creditCalls).toEqual([{ body: { credit_tier: "credits_50" } }]);
    expect(machineCalls).toEqual([]);
    expect(storageCalls).toEqual([]);
    // No compute/disk provisioning is owed, but the credit change persisted, so
    // the caller still opens the takeover.
    expect(captured.value).toEqual({ needsResize: false, creditChanged: true });
  });

  test("toasts the extracted error and returns null on failure", async () => {
    machineImpl = async () => {
      throw { detail: "Payment failed. Your card was declined." };
    };
    const { result } = setup();

    const captured: { value: ChangeTiersResult | null } = {
      value: { needsResize: true, creditChanged: false },
    };
    await act(async () => {
      captured.value = await result.current.changeTiers({
        machineTier: "large",
        storageTier: "xs",
        creditTier: null,
      });
    });

    expect(captured.value).toBeNull();
    expect(toastErrorCalls).toEqual([
      "Payment failed. Your card was declined.",
    ]);
  });

  test("opens the resize takeover when a resource dim lands but credit fails", async () => {
    // Storage upgrade succeeds server-side; the credit change fails. The
    // entitlement already moved, so the caller must still open resize.
    creditImpl = async () => {
      throw { detail: "Payment failed. Your card was declined." };
    };
    subscriptionFixture = proSubscription({ selected_credit_tier: null });
    const { result } = setup();

    const captured: { value: ChangeTiersResult | null } = { value: null };
    await act(async () => {
      captured.value = await result.current.changeTiers({
        machineTier: "medium",
        storageTier: "s",
        creditTier: "credits_50",
      });
    });

    expect(storageCalls).toEqual([{ body: { storage_tier: "s" } }]);
    expect(creditCalls).toEqual([{ body: { credit_tier: "credits_50" } }]);
    expect(toastErrorCalls).toEqual([
      "Payment failed. Your card was declined.",
    ]);
    // The storage upgrade landed (needs a resize); the credit change did not.
    expect(captured.value).toEqual({ needsResize: true, creditChanged: false });
  });

  test("surfaces the takeover when only the credit dim landed and a resource failed", async () => {
    // Machine (the sole resource change) fails; the credit change succeeds. No
    // provisioning is owed, but the persisted credit change still opens the
    // takeover.
    machineImpl = async () => {
      throw { detail: "Machine tier unavailable." };
    };
    const { result } = setup();

    const captured: { value: ChangeTiersResult | null } = { value: null };
    await act(async () => {
      captured.value = await result.current.changeTiers({
        machineTier: "large",
        storageTier: "xs",
        creditTier: "credits_50",
      });
    });

    expect(creditCalls).toEqual([{ body: { credit_tier: "credits_50" } }]);
    expect(toastErrorCalls).toEqual(["Machine tier unavailable."]);
    expect(captured.value).toEqual({ needsResize: false, creditChanged: true });
  });

  test("posting no changes is a successful no-op with no dispatch", async () => {
    const { result, invalidatedKeys } = setup();

    const captured: { value: ChangeTiersResult | null } = { value: null };
    await act(async () => {
      captured.value = await result.current.changeTiers({
        machineTier: "medium",
        storageTier: "xs",
        creditTier: null,
      });
    });

    expect(machineCalls).toEqual([]);
    expect(storageCalls).toEqual([]);
    expect(creditCalls).toEqual([]);
    expect(invalidatedKeys).toEqual([]);
    expect(captured.value).toEqual({
      needsResize: false,
      creditChanged: false,
    });
  });
});
