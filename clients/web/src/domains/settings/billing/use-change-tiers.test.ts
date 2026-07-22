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

// Per-dimension captured bodies + resolution controls.
type Body = { body: Record<string, unknown> };
const machineCalls: Body[] = [];
const storageCalls: Body[] = [];
const creditCalls: Body[] = [];
let machineImpl: (opts: Body) => Promise<unknown>;
let storageImpl: (opts: Body) => Promise<unknown>;
let creditImpl: (opts: Body) => Promise<unknown>;

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  organizationsBillingSubscriptionRetrieveOptions: () => ({
    queryKey: SUBSCRIPTION_KEY,
    queryFn: () => subscriptionFixture,
  }),
  organizationsBillingSubscriptionRetrieveQueryKey: () => SUBSCRIPTION_KEY,
  organizationsBillingSubscriptionOnboardingRetrieveOptions: () => ({
    queryKey: ONBOARDING_KEY,
    queryFn: () => onboardingFixture,
  }),
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey: () =>
    ONBOARDING_KEY,
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
function setup() {
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
  client.setQueryData(SUBSCRIPTION_KEY, subscriptionFixture);
  client.setQueryData(ONBOARDING_KEY, onboardingFixture);
  const invalidatedKeys: unknown[] = [];
  type InvalidateFn = QueryClient["invalidateQueries"];
  const originalInvalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((...args: Parameters<InvalidateFn>) => {
    invalidatedKeys.push(args[0]?.queryKey);
    return originalInvalidate(...args);
  }) as InvalidateFn;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const { result } = renderHook(() => useChangeTiers(), { wrapper });
  return { result, invalidatedKeys };
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
    subscriptionFixture = proSubscription();
    onboardingFixture = onboarding();
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
    expect(invalidatedKeys).toEqual([SUBSCRIPTION_KEY, ONBOARDING_KEY, PLANS_KEY]);
    expect(toastErrorCalls).toEqual([]);
    // A machine change resizes the assistant.
    expect(captured.value).toEqual({ needsResize: true });
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
    expect(captured.value).toEqual({ needsResize: true });
  });

  test("a credit-only change does not need a resize", async () => {
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
    expect(captured.value).toEqual({ needsResize: false });
  });

  test("toasts the extracted error and returns null on failure", async () => {
    machineImpl = async () => {
      throw { detail: "Payment failed. Your card was declined." };
    };
    const { result } = setup();

    const captured: { value: ChangeTiersResult | null } = {
      value: { needsResize: true },
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
    expect(captured.value).toEqual({ needsResize: false });
  });
});
