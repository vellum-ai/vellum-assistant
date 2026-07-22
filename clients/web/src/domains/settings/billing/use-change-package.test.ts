/**
 * Tests for `useChangePackage`. The generated change-package mutation and the
 * three billing query-key factories are `mock.module`-replaced so the hook runs
 * against a controllable `mutationFn` and sentinel keys; `extractMutationError`
 * (real) turns a `{ detail }` reject into the toasted message. The seeded
 * QueryClient uses `staleTime/gcTime: Infinity` + `retry: false` so nothing
 * refetches over the network during the test.
 */
import { beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import type { PackageChangeResponse } from "@/generated/api/types.gen";

// Sentinel query keys let the invalidation assertions match on identity.
const SUBSCRIPTION_KEY = ["subscription"];
const PLANS_KEY = ["plans"];
const ONBOARDING_KEY = ["onboarding"];

// Captures the body posted to `mutateAsync` and lets each test drive the
// mutation's resolution (resolve a response, or reject to hit the error path).
const mutationFnCalls: Array<{ body: { package: string } }> = [];
let mutationImpl: (options: {
  body: { package: string };
}) => Promise<PackageChangeResponse>;

mock.module("@/generated/api/@tanstack/react-query.gen", () => ({
  organizationsBillingSubscriptionChangePackageCreateMutation: () => ({
    mutationFn: (options: { body: { package: string } }) => {
      mutationFnCalls.push(options);
      return mutationImpl(options);
    },
  }),
  organizationsBillingSubscriptionRetrieveQueryKey: () => SUBSCRIPTION_KEY,
  organizationsBillingPlansRetrieveQueryKey: () => PLANS_KEY,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey: () =>
    ONBOARDING_KEY,
}));

const toastErrorCalls: string[] = [];
mock.module("@vellumai/design-library/components/toast", () => ({
  toast: {
    error: (message: string) => {
      toastErrorCalls.push(message);
    },
  },
}));

const { useChangePackage } = await import("./use-change-package");

function okResponse(): PackageChangeResponse {
  return {
    status: "ok",
    package: { key: "ultra", name: "Ultra", version: 1, customized: false },
  };
}

/**
 * Render the hook against a fresh QueryClient and record every key passed to
 * `invalidateQueries` so the three-key billing invalidation can be asserted.
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
  const invalidatedKeys: unknown[] = [];
  type InvalidateFn = QueryClient["invalidateQueries"];
  const originalInvalidate = client.invalidateQueries.bind(client);
  client.invalidateQueries = ((...args: Parameters<InvalidateFn>) => {
    invalidatedKeys.push(args[0]?.queryKey);
    return originalInvalidate(...args);
  }) as InvalidateFn;
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client }, children);
  const { result } = renderHook(() => useChangePackage(), { wrapper });
  return { result, invalidatedKeys };
}

describe("useChangePackage", () => {
  beforeEach(() => {
    mutationFnCalls.length = 0;
    toastErrorCalls.length = 0;
    mutationImpl = async () => okResponse();
  });

  test("posts the package and invalidates the three billing keys on success", async () => {
    const response = okResponse();
    mutationImpl = async () => response;
    const { result, invalidatedKeys } = setup();

    const captured: { value: PackageChangeResponse | null } = { value: null };
    await act(async () => {
      captured.value = await result.current.changePackage("ultra");
    });

    expect(captured.value).toEqual(response);
    expect(mutationFnCalls).toEqual([{ body: { package: "ultra" } }]);
    expect(invalidatedKeys).toEqual([SUBSCRIPTION_KEY, PLANS_KEY, ONBOARDING_KEY]);
    expect(toastErrorCalls).toEqual([]);
  });

  test("toasts the extracted message and resolves null on error", async () => {
    mutationImpl = async () => {
      throw { detail: "Payment failed. Your card was declined." };
    };
    const { result, invalidatedKeys } = setup();

    const captured: { value: PackageChangeResponse | null } = {
      value: okResponse(),
    };
    await act(async () => {
      captured.value = await result.current.changePackage("ultra");
    });

    expect(captured.value).toBeNull();
    expect(toastErrorCalls).toEqual([
      "Payment failed. Your card was declined.",
    ]);
    expect(invalidatedKeys).toEqual([]);
  });

  test("isPending reflects the underlying mutation pending flag", async () => {
    let release!: (value: PackageChangeResponse) => void;
    mutationImpl = () =>
      new Promise<PackageChangeResponse>((resolve) => {
        release = resolve;
      });
    const { result } = setup();

    expect(result.current.isPending).toBe(false);

    let pending: Promise<PackageChangeResponse | null>;
    act(() => {
      pending = result.current.changePackage("mighty");
    });
    await waitFor(() => expect(result.current.isPending).toBe(true));

    await act(async () => {
      release(okResponse());
      await pending;
    });
    await waitFor(() => expect(result.current.isPending).toBe(false));
  });
});
