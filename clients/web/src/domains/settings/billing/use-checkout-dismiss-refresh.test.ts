/**
 * Tests for `useCheckoutDismissRefresh`. `openUrlFinishedListener` is
 * `mock.module`-replaced so the test can fire the Capacitor `browserFinished`
 * event by hand and assert the three billing queries are invalidated — the
 * only signal native iOS gives the app that an in-app Checkout sheet closed.
 */
import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import {
  organizationsBillingPlansRetrieveQueryKey,
  organizationsBillingSubscriptionOnboardingRetrieveQueryKey,
  organizationsBillingSubscriptionRetrieveQueryKey,
} from "@/generated/api/@tanstack/react-query.gen";

// Captures the subscriber so a test can fire `browserFinished` on demand, and
// records that the subscription is torn down on unmount.
let finishedCallback: (() => void) | null = null;
let unsubscribeCalls = 0;
mock.module("@/runtime/browser", () => ({
  openUrlFinishedListener: (cb: () => void) => {
    finishedCallback = cb;
    return () => {
      unsubscribeCalls += 1;
      finishedCallback = null;
    };
  },
}));

const { useCheckoutDismissRefresh } = await import(
  "./use-checkout-dismiss-refresh"
);

function setup() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
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
  const view = renderHook(() => useCheckoutDismissRefresh(), { wrapper });
  return { invalidatedKeys, view };
}

beforeEach(() => {
  finishedCallback = null;
  unsubscribeCalls = 0;
});

afterEach(() => {
  cleanup();
});

describe("useCheckoutDismissRefresh", () => {
  test("subscribes to the browser-finished event", () => {
    setup();
    expect(finishedCallback).not.toBeNull();
  });

  test("refetches the billing queries when the sheet closes", () => {
    const { invalidatedKeys } = setup();

    // Nothing until the sheet is actually dismissed.
    expect(invalidatedKeys).toEqual([]);

    finishedCallback!();

    expect(invalidatedKeys).toEqual([
      organizationsBillingSubscriptionRetrieveQueryKey(),
      organizationsBillingPlansRetrieveQueryKey(),
      organizationsBillingSubscriptionOnboardingRetrieveQueryKey(),
    ]);
  });

  test("unsubscribes on unmount", () => {
    const { view } = setup();
    view.unmount();
    expect(unsubscribeCalls).toBe(1);
  });
});
