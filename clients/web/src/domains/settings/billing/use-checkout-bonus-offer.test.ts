/**
 * Tests for `useCheckoutBonusOffer` gating:
 *  - no cancel signal: the eligibility endpoint is never queried and no offer
 *    shows, whatever the server would say
 *  - triggered before the org store settles: the query waits for org
 *    readiness (a header-less request would be rejected), then fires once
 *  - triggered + server says ineligible: exactly one request and no offer,
 *    so hand-typed cancel URLs stay quiet
 *  - triggered + server says eligible: the offer shows with the
 *    server-returned amount
 *  - a first cancel arriving on an already-mounted tab: exactly one request
 *    (the enabled transition fetches; the repeat-trigger invalidation must
 *    not double up)
 *  - a repeat cancel on the same persistent mount (the Electron/iOS case:
 *    no document reload, no remount): re-asks the server once per trigger,
 *    and a stale `eligible: true` from the previous cancel is not re-shown
 *    while the fresh verification is in flight
 *  - a repeat cancel across a remount (the web case): the cached ineligible
 *    answer behind the app's 10s default staleTime is not reused
 *
 * The GET is mocked at the SDK boundary so the real generated query factory
 * stays in the loop, mirroring checkout-bonus-modal.test.tsx.
 */

import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { cleanup, renderHook, waitFor } from "@testing-library/react";
import { createElement, type ReactNode } from "react";

import * as sdkGen from "@/generated/api/sdk.gen";
import type { CheckoutBonusEligibilityResponse } from "@/generated/api/types.gen";

let retrieveCalls = 0;
let eligibilityResponse: CheckoutBonusEligibilityResponse;
let orgReady = true;
// When set, in-flight responses wait until the test releases them.
let releaseResponse: (() => void) | null = null;
let holdResponses = false;

mock.module("@/generated/api/sdk.gen", () => ({
  ...sdkGen,
  organizationsBillingCheckoutBonusRetrieve: async () => {
    retrieveCalls += 1;
    if (holdResponses) {
      await new Promise<void>((resolve) => {
        releaseResponse = resolve;
      });
    }
    return {
      data: eligibilityResponse,
      response: { ok: true },
    };
  },
}));

mock.module("@/hooks/use-is-org-ready", () => ({
  useIsOrgReady: () => orgReady,
}));

const { useCheckoutBonusOffer } = await import("./use-checkout-bonus-offer");

function setup(cancelledAt: number | null, client?: QueryClient) {
  const queryClient =
    client ??
    new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });
  const wrapper = ({ children }: { children: ReactNode }) =>
    createElement(QueryClientProvider, { client: queryClient }, children);
  return renderHook((props) => useCheckoutBonusOffer(props.cancelledAt), {
    initialProps: { cancelledAt },
    wrapper,
  });
}

// Lets any wrongly-enabled fetch land before asserting a call count of zero.
// Also long enough that a `Date.now()` taken after it postdates any response
// that already resolved, so successive triggers get distinct timestamps.
const flush = () => new Promise((resolve) => setTimeout(resolve, 10));

beforeEach(() => {
  retrieveCalls = 0;
  eligibilityResponse = { eligible: true, amount_usd: "5.00" };
  orgReady = true;
  releaseResponse = null;
  holdResponses = false;
});

afterEach(() => {
  cleanup();
});

describe("useCheckoutBonusOffer", () => {
  test("no cancel signal: never queries, never offers", async () => {
    const { result } = setup(null);

    await flush();
    expect(retrieveCalls).toBe(0);
    expect(result.current.showOffer).toBe(false);
  });

  test("triggered before the org settles: waits, then fires once", async () => {
    orgReady = false;
    const cancelledAt = Date.now();
    const { result, rerender } = setup(cancelledAt);

    await flush();
    expect(retrieveCalls).toBe(0);
    expect(result.current.showOffer).toBe(false);

    orgReady = true;
    rerender({ cancelledAt });

    await waitFor(() => expect(result.current.showOffer).toBe(true));
    expect(retrieveCalls).toBe(1);
  });

  test("triggered + ineligible: one request, no offer", async () => {
    eligibilityResponse = { eligible: false, amount_usd: "0.00" };
    const { result } = setup(Date.now());

    await waitFor(() => expect(retrieveCalls).toBe(1));
    await flush();
    expect(result.current.showOffer).toBe(false);
  });

  test("triggered + eligible: offers the server-returned amount", async () => {
    eligibilityResponse = { eligible: true, amount_usd: "7.50" };
    const { result } = setup(Date.now());

    await waitFor(() => expect(result.current.showOffer).toBe(true));
    expect(result.current.amountUsd).toBe("7.50");
    expect(retrieveCalls).toBe(1);
  });

  test("first cancel on an already-mounted tab: exactly one request", async () => {
    const { result, rerender } = setup(null);

    await flush();
    expect(retrieveCalls).toBe(0);

    rerender({ cancelledAt: Date.now() });

    await waitFor(() => expect(result.current.showOffer).toBe(true));
    await flush();
    expect(retrieveCalls).toBe(1);
  });

  test("repeat cancel on a persistent mount: re-asks the server", async () => {
    // Mirror the app QueryClient (providers.tsx): a 10s default staleTime.
    // The mount never cycles, so `enabled` never re-transitions; the hook
    // must refetch off the trigger itself.
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 10_000 } },
    });

    eligibilityResponse = { eligible: false, amount_usd: "0.00" };
    const { result, rerender } = setup(Date.now(), client);
    await waitFor(() => expect(retrieveCalls).toBe(1));
    await flush();
    expect(result.current.showOffer).toBe(false);

    // A real abandoned checkout lands moments later, on the same mount.
    eligibilityResponse = { eligible: true, amount_usd: "5.00" };
    rerender({ cancelledAt: Date.now() });

    await waitFor(() => expect(result.current.showOffer).toBe(true));
    expect(result.current.amountUsd).toBe("5.00");
    expect(retrieveCalls).toBe(2);
  });

  test("repeat cancel: stale eligible answer stays hidden until re-verified", async () => {
    const { result, rerender } = setup(Date.now());
    await waitFor(() => expect(result.current.showOffer).toBe(true));
    await flush();

    // Second cancel on the same mount; hold the fresh answer in flight.
    holdResponses = true;
    rerender({ cancelledAt: Date.now() });

    await waitFor(() => expect(retrieveCalls).toBe(2));
    // The previous `eligible: true` predates this trigger, so no offer yet.
    expect(result.current.showOffer).toBe(false);

    eligibilityResponse = { eligible: true, amount_usd: "5.00" };
    releaseResponse?.();

    await waitFor(() => expect(result.current.showOffer).toBe(true));
    expect(retrieveCalls).toBe(2);
  });

  test("repeat trigger across a remount: refetches past the app's 10s default staleTime", async () => {
    const client = new QueryClient({
      defaultOptions: { queries: { retry: false, staleTime: 10_000 } },
    });

    eligibilityResponse = { eligible: false, amount_usd: "0.00" };
    const first = setup(Date.now(), client);
    await waitFor(() => expect(retrieveCalls).toBe(1));
    await flush();
    expect(first.result.current.showOffer).toBe(false);
    first.unmount();

    // A real abandoned checkout lands within the staleness window.
    eligibilityResponse = { eligible: true, amount_usd: "5.00" };
    const second = setup(Date.now(), client);

    await waitFor(() => expect(second.result.current.showOffer).toBe(true));
    expect(second.result.current.amountUsd).toBe("5.00");
    expect(retrieveCalls).toBe(2);
  });
});
